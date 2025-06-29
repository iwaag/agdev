FROM golang:1.24-bookworm AS builder
#RUN apk add --no-cache gcc musl-dev
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download

COPY . .
#RUN CGO_ENABLED=1 GOOS=linux go build -a -installsuffix cgo -o main .
RUN CGO_ENABLED=1 GOOS=linux go build -v -x -o main .

FROM debian:bookworm
RUN apt-get update && apt-get install -y ca-certificates sqlite3 bash
WORKDIR /root/

COPY --from=builder /app/main .

EXPOSE 3003
CMD ./main