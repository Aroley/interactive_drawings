/**
 * Simple Socket.IO relay server
 * Receives drawings from tablets and broadcasts them to projectors
 */

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Serve static files (draw.html & project.html)
app.use(express.static("public"));

io.on("connection", (socket) => {
  console.log("Client connected:", socket.id);

  // Receive drawing from tablet
  socket.on("drawing", (imageData) => {
    // Broadcast to everyone else (projector)
    socket.broadcast.emit("newDrawing", imageData);
  });

  socket.on("disconnect", () => {
    console.log("Client disconnected:", socket.id);
  });
});

server.listen(3000, () => {
  console.log("Server running on http://localhost:3000");
});
