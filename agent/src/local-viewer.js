import { EventEmitter } from "node:events";
import http from "node:http";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const viewerPackagePath = require.resolve("prismarine-viewer/package.json");
const viewerRequire = createRequire(viewerPackagePath);
const express = viewerRequire("express");
const { Server: SocketServer } = viewerRequire("socket.io");
const { setupRoutes } = viewerRequire("./lib/common.js");
const { WorldView } = require("prismarine-viewer").viewer;

/**
 * Loopback-only variant of prismarine-viewer's Mineflayer adapter.
 * Upstream 1.33.0 calls listen(port), which binds every interface; this keeps
 * the same MIT-licensed adapter behavior while explicitly binding the host.
 */
export async function startLocalViewer(
  bot,
  { host = "127.0.0.1", port = 3007, firstPerson = true, viewDistance = 6, prefix = "" } = {}
) {
  if (host !== "127.0.0.1" && host !== "::1") {
    throw new Error("local viewer host must be a loopback address");
  }

  const app = express();
  const server = http.createServer(app);
  const io = new SocketServer(server, { path: `${prefix}/socket.io` });
  setupRoutes(app, prefix);

  const sockets = [];
  const primitives = {};
  const viewer = new EventEmitter();
  bot.viewer = viewer;

  viewer.erase = (id) => {
    delete primitives[id];
    for (const socket of sockets) socket.emit("primitive", { id });
  };

  viewer.drawBoxGrid = (id, start, end, color = "aqua") => {
    primitives[id] = { type: "boxgrid", id, start, end, color };
    for (const socket of sockets) socket.emit("primitive", primitives[id]);
  };

  viewer.drawLine = (id, points, color = 0xff0000) => {
    primitives[id] = { type: "line", id, points, color };
    for (const socket of sockets) socket.emit("primitive", primitives[id]);
  };

  viewer.drawPoints = (id, points, color = 0xff0000, size = 5) => {
    primitives[id] = { type: "points", id, points, color, size };
    for (const socket of sockets) socket.emit("primitive", primitives[id]);
  };

  io.on("connection", (socket) => {
    socket.emit("version", bot.version);
    sockets.push(socket);

    const worldView = new WorldView(bot.world, viewDistance, bot.entity.position, socket);
    worldView.init(bot.entity.position);

    const botPosition = () => {
      const packet = { pos: bot.entity.position, yaw: bot.entity.yaw, addMesh: true };
      if (firstPerson) packet.pitch = bot.entity.pitch;
      socket.emit("position", packet);
      worldView.updatePosition(bot.entity.position);
    };

    worldView.on("blockClicked", (block, face, button) => {
      viewer.emit("blockClicked", block, face, button);
    });
    for (const id of Object.keys(primitives)) socket.emit("primitive", primitives[id]);
    bot.on("move", botPosition);
    worldView.listenToBot(bot);

    socket.on("disconnect", () => {
      bot.removeListener("move", botPosition);
      worldView.removeListenersFromBot(bot);
      const index = sockets.indexOf(socket);
      if (index >= 0) sockets.splice(index, 1);
    });
  });

  await new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    server.once("error", onError);
    server.listen(port, host, () => {
      server.removeListener("error", onError);
      resolve();
    });
  });

  viewer.close = () => {
    for (const socket of [...sockets]) socket.disconnect(true);
    io.close();
    if (server.listening) server.close();
  };

  return { host, port, url: `http://${host}:${port}` };
}
