// Packages import ws for their own sockets, like discord.js's Gateway connection, which the bot
// host holds instead. Importing it works; opening a connection says why it can't.
export class WebSocket {
  constructor() {
    throw new Error("ws can't open connections in an isolate.")
  }
}

export default WebSocket
