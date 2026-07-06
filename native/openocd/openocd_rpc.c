// OpenOCD TCL-RPC client (v1 minimal). See openocd_rpc.h.
#include "openocd_rpc.h"

#include <arpa/inet.h>
#include <netinet/in.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>

struct flux_openocd {
    int fd;
};

int flux_openocd_connect(flux_openocd **out, const char *host, uint16_t port) {
    if (!out || !host) return -1;
    int fd = socket(AF_INET, SOCK_STREAM, 0);
    if (fd < 0) return -2;
    struct sockaddr_in addr = {0};
    addr.sin_family = AF_INET;
    addr.sin_port = htons(port);
    if (inet_pton(AF_INET, host, &addr.sin_addr) != 1) { close(fd); return -3; }
    if (connect(fd, (struct sockaddr *)&addr, sizeof(addr)) != 0) { close(fd); return -4; }
    flux_openocd *h = (flux_openocd *)calloc(1, sizeof(*h));
    if (!h) { close(fd); return -5; }
    h->fd = fd;
    *out = h;
    return 0;
}

int flux_openocd_cmd(flux_openocd *h, const char *cmd, char *buf, size_t buf_len) {
    if (!h || !cmd || !buf || buf_len == 0) return -1;
    // OpenOCD TCL expects the command followed by 0x1a terminator.
    size_t n = strlen(cmd);
    if (write(h->fd, cmd, n) != (ssize_t)n) return -2;
    if (write(h->fd, "\x1a", 1) != 1) return -3;
    // Read until 0x1a terminator.
    size_t total = 0;
    while (total < buf_len - 1) {
        ssize_t r = read(h->fd, buf + total, buf_len - 1 - total);
        if (r <= 0) break;
        total += (size_t)r;
        for (size_t i = total - (size_t)r; i < total; i++) {
            if (buf[i] == '\x1a') { buf[i] = '\0'; return (int)i; }
        }
    }
    buf[buf_len - 1] = '\0';
    return (int)total;
}

void flux_openocd_close(flux_openocd *h) {
    if (!h) return;
    if (h->fd >= 0) close(h->fd);
    free(h);
}
