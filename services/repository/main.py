import os
import sqlite3
import fsspec
from datetime import datetime
from typing import Optional, Dict, Any
from fastapi import FastAPI, HTTPException, UploadFile, File, Form
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
import json
import pathlib
class MetadataModel(BaseModel):
    description: str
    evaluation: str
    additional_info: str

class MetadataUpdate(BaseModel):
    file_path: str
    parameter_name: str
    value: str
# Configuration from environment variables
class StorageHelper:
    def __init__(self, storage_config_json: str):
        self.storage_config = json.loads(storage_config_json)
        self.storage_type = self.storage_config.get('type', 'file').lower()
        if self.storage_type == 'file':
            self.absolute_root = os.path.abspath(self.storage_config.get('root', 'storage'))
            self.file_system = fsspec.filesystem('file')
        elif self.storage_type == 's3':
            self.absolute_root = self.storage_config.get('root', f's3://{self.storage_config.get("bucket_name", "my-bucket")}')
            self.file_system = fsspec.filesystem('s3', 
                                                 key=self.storage_config.get('awsAccessKeyId'), 
                                                 secret=self.storage_config.get('awsSecretAccessKey'))
        elif self.storage_type == 'gcs':
            self.absolute_root = self.storage_config.get('root', f'gcs://{self.storage_config.get("bucket_name", "my-bucket")}')
            self.file_system = fsspec.filesystem('gcs',
                                                    token=self.storage_config.get('gcpServiceAccountKey'))
        else:
            raise ValueError(f"Unsupported storage type: {self.storage_type}")
        self.database_path = self.get_absolute_path("metadata.db")
        self.init_database()
    def get_absolute_path(self, relative_path: str):
        return self.absolute_root + "/" + relative_path
    def init_database(self):
        """Initialize SQLite database"""
        print(f"Initializing database at {self.database_path}")
        conn = sqlite3.connect(self.database_path)
        cursor = conn.cursor()
        cursor.execute('''
            CREATE TABLE IF NOT EXISTS file_metadata (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                file_path TEXT UNIQUE NOT NULL,
                description TEXT NOT NULL,
                evaluation TEXT NOT NULL,
                additional_info TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        ''')
        conn.commit()
        conn.close()
    def ensure_parent_directories(self, full_file_path: str):
        parent_dir = pathlib.PurePosixPath(full_file_path).parent
        if parent_dir:
            try:
                self.file_system.makedirs(str(parent_dir), exist_ok=True)
            except Exception as e:
                if self.file_system.protocol in ["file", "local"]:
                    raise RuntimeError(f"Failed to create directory: {e}")
                # Otherwise, it's a virtual FS; skip
    def write_file_to_storage(self, file_path: str, content: bytes):
        full_path = self.get_absolute_path(file_path)
        self.ensure_parent_directories(full_path)
        with self.file_system.open(full_path, 'wb') as f:
            f.write(content)
    def get_file_metadata(self, file_path: str):
        """Get file metadata from database"""
        conn = sqlite3.connect(self.database_path)
        cursor = conn.cursor()
        cursor.execute('''
            SELECT file_path, description, evaluation, additional_info, created_at, updated_at
            FROM file_metadata 
            WHERE file_path = ?
        ''', (file_path,))
        
        result = cursor.fetchone()
        conn.close()
        
        if result:
            #additional_info = json.loads(result[3]) if result[3] else {}
            return {
                'file_path': result[0],
                'description': result[1],
                'evaluation': result[2],
                'additional_info': result[3],
                'created_at': result[4],
                'updated_at': result[5]
            }
        return None
    def save_file_metadata(self, file_path: str, metadata: MetadataModel):
        conn = sqlite3.connect(self.database_path)
        cursor = conn.cursor()
        #additional_info_json = json.dumps(metadata.additional_info) if metadata.additional_info else '{}'
        cursor.execute('''
            INSERT OR REPLACE INTO file_metadata 
            (file_path, description, evaluation, additional_info, updated_at)
            VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
        ''', (file_path, metadata.description, metadata.evaluation, metadata.additional_info))
        conn.commit()
        conn.close()
    def update_metadata_parameter(self, file_path: str, parameter_name: str, value: str):
        conn = sqlite3.connect(self.database_path)
        cursor = conn.cursor()
        print(f"Updating {parameter_name} for {file_path} to {value}")
        # Get current metadata
        cursor.execute('''
            SELECT description, evaluation, additional_info
            FROM file_metadata 
            WHERE file_path = ?
        ''', (file_path,))
        print(f"Executing query for {file_path}")
        result = cursor.fetchone()
        print(f"Query result: {result}")
        if not result:
            conn.close()
            raise HTTPException(status_code=404, detail="File not found")
        
        description, evaluation, additional_info = result
        
        # Update the parameter
        if parameter_name == 'description':
            description = value
        elif parameter_name == 'evaluation':
            evaluation = value
        elif parameter_name == 'additional_info':
            additional_info = value
        
        # Save updated metadata
        cursor.execute('''
            UPDATE file_metadata 
            SET description = ?, evaluation = ?, additional_info = ?, updated_at = CURRENT_TIMESTAMP
            WHERE file_path = ? 
        ''', (description, evaluation, additional_info, file_path))
        
        conn.commit()
        conn.close()


STORAGE_CONFIG_JSON = os.getenv('STORAGE_CONFIG_JSON', '{"type": "file", "root": "storage"}')
HISTORY_STORAGE_CONFIG_JSON = os.getenv('HISTORY_STORAGE_CONFIG_JSON', '{"type": "file", "root": "history"}')
main_helper = StorageHelper(STORAGE_CONFIG_JSON)
history_helper = StorageHelper(HISTORY_STORAGE_CONFIG_JSON)
# S3/GCS configuration
app = FastAPI(title="File Storage API")


#only assume POSIX path
def get_next_version(file_path: str):
    posix_path = pathlib.PurePosixPath(file_path)
    suffix = posix_path.suffix
    
    # Get highest version number
    conn = sqlite3.connect(history_helper.database_path)
    cursor = conn.cursor()
    cursor.execute('''
        SELECT MAX(CAST(SUBSTR(file_path, LENGTH(?) + 2, LENGTH(file_path) - LENGTH(?) - LENGTH(?) - 1) AS INTEGER))
        FROM file_metadata 
        WHERE file_path LIKE ? AND file_path GLOB ?
    ''', (file_path, file_path, suffix, f"{file_path}.%.{suffix[1:]}", f"{file_path}.[0-9]*{suffix}"))
    
    result = cursor.fetchone()
    conn.close()
    
    # Get next version number (start from 1 if no existing versions)
    next_version = (result[0] or 0) + 1
    
    return next_version

def get_latest_history_path(file_path: str):
    """Get the latest existing version."""
    conn = sqlite3.connect(history_helper.database_path)
    cursor = conn.cursor()
    posix_path = pathlib.PurePosixPath(file_path)
    suffix = posix_path.suffix
    base_path = str(posix_path.with_suffix(''))
    
    cursor.execute('''
        SELECT file_path
        FROM file_metadata 
        WHERE file_path LIKE ? AND file_path GLOB ?
        ORDER BY CAST(SUBSTR(file_path, LENGTH(?) + 2, LENGTH(file_path) - LENGTH(?) - LENGTH(?) - 1) AS INTEGER) DESC
        LIMIT 1
    ''', (f"{base_path}.%.{suffix[1:]}", f"{base_path}.[0-9]*{suffix}", base_path, base_path, suffix))
    
    result = cursor.fetchone()
    conn.close()
    return result[0] if result else None

def make_history_file_path(source_file_path: str, version: int) -> str:
    suffix = pathlib.PurePosixPath(source_file_path).suffix
    return  f"{source_file_path}.{version}{suffix}"

def get_next_version_path(file_path: str):
    return make_history_file_path(file_path, get_next_version(file_path))

def move_to_history(source_file_path: str):
    full_path = main_helper.get_absolute_path(source_file_path)
    if not main_helper.file_system.exists(full_path):
        return  # File does not exist, nothing to move
    with main_helper.file_system.open(full_path, 'rb') as src:
        content = src.read()  # Synchronous read
    history_file_path = get_next_version_path(source_file_path)
    if not history_file_path:
        history_file_path = make_history_file_path(source_file_path, 1)
    history_helper.write_file_to_storage(history_file_path, content)
    original_metadata = main_helper.get_file_metadata(source_file_path)
    if original_metadata:
        history_helper.save_file_metadata(history_file_path,
            MetadataModel(
                description=original_metadata['description'],
                evaluation=original_metadata['evaluation'],
                additional_info=original_metadata['additional_info']
            ))

@app.post("/files/upload")
async def upload_file(
    file: UploadFile = File(...),
    file_path: str = Form(...),
    description: str = Form(...),
    evaluation: str = Form(...),
    additional_info: str = Form(...)
):
    
    metadata = MetadataModel(
        description=description,
        evaluation=evaluation,
        additional_info=additional_info
    )
    print(f"Uploading file: {file_path}, Description: {description}, Evaluation: {evaluation}, Additional Info: {additional_info}")
    #move to history if file already exists
    move_to_history(file_path)
    print(f"Moved existing file to history: {file_path}")
    # Write file to main storage
    content = await file.read()
    main_helper.write_file_to_storage(file_path, content)
    main_helper.save_file_metadata(file_path, metadata)
    return {"message": "File uploaded successfully"}

@app.get("/files/download")
async def download_file(file_path: str, version: Optional[int] = None):
    full_path = main_helper.get_absolute_path(file_path)
    
    if not main_helper.file_system.exists(full_path):
        raise HTTPException(status_code=404, detail="File not found")
    if version:
        history_file_path = make_history_file_path(file_path, version)
        full_history_path = main_helper.get_absolute_path(history_file_path)
        content = history_helper.file_system.read_bytes(full_history_path)
    else:
        content = main_helper.file_system.read_bytes(full_path)
    return StreamingResponse(
        iter([content]),
        media_type='application/octet-stream',
        headers={"Content-Disposition": f"attachment; filename={os.path.basename(file_path)}"}
    )

@app.get("/files/metadata")
async def get_metadata(file_path: str, version: Optional[int] = None):
    if version:
        metadata = history_helper.get_file_metadata(make_history_file_path(file_path, version))
    else:
        metadata = main_helper.get_file_metadata(file_path)

    if not metadata:
        raise HTTPException(status_code=404, detail="File or version not found")
    
    return metadata

@app.put("/files/metadata")
async def update_metadata(update: MetadataUpdate):
    """Update a specific parameter in file metadata"""
    try:
        main_helper.update_metadata_parameter(update.file_path, update.parameter_name, update.value)
        return {"message": "Metadata updated successfully"}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/files/history-count")
async def get_history_count(file_path: str):
    return str(get_next_version(file_path) - 1)

@app.get("/files/list")
async def entity_list(root_path: str):
    full_path = main_helper.get_absolute_path(root_path)
    paths = main_helper.file_system.ls(full_path, detail=False)
    infos = []
    for i in range(len(paths)):
        isFile = main_helper.file_system.isfile(paths[i])
        relative_path = pathlib.PurePosixPath(paths[i]).relative_to(main_helper.absolute_root)
        infos.append({
            "path": relative_path,
            "is_file": isFile,
        })
    return {"entities": infos}

@app.get("/")
async def root():
    """API health check"""
    return {"message": "File Storage API is running", "storage_type": main_helper.storage_type}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)