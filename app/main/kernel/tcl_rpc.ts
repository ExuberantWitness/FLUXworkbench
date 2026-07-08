// OpenOCD TCL-RPC client (TypeScript) — connects to OpenOCD's tcl_port (default 6666).
// Sends TCL commands terminated by \x1a; receives replies terminated by \x1a.
// This is the "proper integration" seam (not stdout-scraping) — the same protocol
// as native/openocd/openocd_rpc.c, now in TS for the kernel to use directly.

import { createConnection, type Socket } from "node:net";

const TCL_EOF = 0x1a;

export class TclRpc {
  private sock: Socket | null = null;
  private buf = "";

  async connect(host = "127.0.0.1", port = 6666): Promise<void> {
    return new Promise((resolve, reject) => {
      this.sock = createConnection({ host, port }, () => resolve());
      this.sock.setEncoding("utf8");
      this.sock.on("error", (err) => reject(err));
    });
  }

  /** Send one TCL command; resolve with the reply string (stripped of \x1a). */
  cmd(command: string, timeoutMs = 10000): Promise<string> {
    return new Promise((resolve, reject) => {
      if (!this.sock || this.sock.destroyed) {
        reject(new Error("not connected"));
        return;
      }
      let reply = "";
      const timer = setTimeout(() => {
        this.sock?.removeListener("data", onData);
        reject(new Error(`timeout: ${command}`));
      }, timeoutMs);

      const onData = (chunk: string): void => {
        reply += chunk;
        const eof = reply.charCodeAt(reply.length - 1);
        if (eof === TCL_EOF) {
          clearTimeout(timer);
          this.sock?.removeListener("data", onData);
          resolve(reply.slice(0, -1));
        }
      };
      this.sock.on("data", onData);
      this.sock.write(command + String.fromCharCode(TCL_EOF));
    });
  }

  close(): void {
    this.sock?.destroy();
    this.sock = null;
  }
}
