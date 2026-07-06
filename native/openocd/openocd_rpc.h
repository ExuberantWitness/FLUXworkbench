// OpenOCD TCL-RPC client (v1 minimal). OpenOCD exposes a TCL server on
// `tcl_port` (default 6666) accepting text commands terminated by `\x1a`.
// This is the structured-command seam — not stdout-scraping.
//
// v1 scope: connect / send / recv / close; flash write_image / halt / mdw / reset.
// Hard-RT (core pinning, SCHED_FIFO) deferred — OpenOCD binary owns it when it lands.

#ifndef FLUX_OPENOCD_RPC_H
#define FLUX_OPENOCD_RPC_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct flux_openocd flux_openocd;  // opaque handle

// Connect to OpenOCD TCL port (host:port). Returns 0 on success.
int flux_openocd_connect(flux_openocd **out, const char *host, uint16_t port);

// Send one TCL command; reply written to `buf` (NUL-terminated). Returns reply length or <0 on error.
int flux_openocd_cmd(flux_openocd *h, const char *cmd, char *buf, size_t buf_len);

void flux_openocd_close(flux_openocd *h);

#ifdef __cplusplus
}
#endif

#endif  // FLUX_OPENOCD_RPC_H
