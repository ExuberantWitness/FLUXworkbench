// Standalone OpenOCD driver CLI (v1). TS supervisor spawns this as a subprocess;
// it bridges stdin commands to OpenOCD TCL RPC, prints replies to stdout.
// Future: replaced/augmented by N-API addon form factor.
#include "openocd_rpc.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

int main(int argc, char **argv) {
    const char *host = (argc > 1) ? argv[1] : "127.0.0.1";
    uint16_t port = (argc > 2) ? (uint16_t)atoi(argv[2]) : 6666;
    flux_openocd *h = NULL;
    int rc = flux_openocd_connect(&h, host, port);
    if (rc != 0) { fprintf(stderr, "connect %s:%u failed: %d\n", host, port, rc); return 1; }

    char line[1024];
    char reply[8192];
    fprintf(stderr, "flux_openocd_cli connected to %s:%u (one TCL command per line; EOF to quit)\n", host, port);
    while (fgets(line, sizeof(line), stdin)) {
        size_t n = strlen(line);
        while (n && (line[n-1] == '\n' || line[n-1] == '\r')) line[--n] = '\0';
        if (n == 0) continue;
        int r = flux_openocd_cmd(h, line, reply, sizeof(reply));
        if (r < 0) { fprintf(stderr, "cmd error: %d\n", r); break; }
        printf("%s\n", reply);
        fflush(stdout);
    }
    flux_openocd_close(h);
    return 0;
}
