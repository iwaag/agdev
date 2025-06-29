package main

import (
	"io"
	"log"
	"net/http"
	"sync"

	"github.com/gorilla/websocket"
)

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool { return true },
}

type Hub struct {
	clients map[*websocket.Conn]bool
	mu      sync.RWMutex
}

func (h *Hub) addClient(conn *websocket.Conn) {
	h.mu.Lock()
	h.clients[conn] = true
	h.mu.Unlock()
	log.Println("Client connected:", conn.RemoteAddr())
}

func (h *Hub) removeClient(conn *websocket.Conn) {
	h.mu.Lock()
	delete(h.clients, conn)
	h.mu.Unlock()
	conn.Close()
	log.Println("Client disconnected:", conn.RemoteAddr())
}

func (h *Hub) broadcast(message []byte) {
	h.mu.RLock()
	defer h.mu.RUnlock()
	log.Printf("Broadcasting message to %d clients: %s\n", len(h.clients), message)
	for conn := range h.clients {
		if err := conn.WriteMessage(websocket.TextMessage, message); err != nil {
			log.Println("Error writing to client:", conn.RemoteAddr(), err)
			go h.removeClient(conn)
		}
	}
}

var hub = &Hub{clients: make(map[*websocket.Conn]bool)}

func fluentHandler(w http.ResponseWriter, r *http.Request) {
	log.Println("Received POST /fluent from", r.RemoteAddr)
	body, err := io.ReadAll(r.Body)
	if err != nil {
		log.Println("Error reading body:", err)
		http.Error(w, "Bad Request", 400)
		return
	}
	log.Println("Body:", string(body))
	hub.broadcast(body)
	w.WriteHeader(200)
	log.Println("200 OK sent to", r.RemoteAddr)
}

func clientHandler(w http.ResponseWriter, r *http.Request) {
	log.Println("WebSocket connection requested from", r.RemoteAddr)
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Println("WebSocket upgrade failed:", err)
		return
	}
	hub.addClient(conn)

	for {
		_, _, err := conn.ReadMessage()
		if err != nil {
			log.Println("Read error from", conn.RemoteAddr(), ":", err)
			hub.removeClient(conn)
			break
		}
	}
}

func main() {
	log.Println("Server starting on :8004")
	http.HandleFunc("/fluent", fluentHandler)
	http.HandleFunc("/client", clientHandler)
	if err := http.ListenAndServe(":8000", nil); err != nil {
		log.Fatal("Server error:", err)
	}
}
