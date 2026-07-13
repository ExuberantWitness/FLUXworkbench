"""Renode × Newton lockstep co-simulation bridge (simulation primitive, phase 5b).

The multi-domain loop: real firmware executes in Renode (electronic domain),
Newton integrates the motor+pendulum articulation (physical domain), and this
bridge exchanges register-level state at a fixed timestep:

    duty  <- sysbus ReadDoubleWord TIM1.CCR1   (firmware PID output, 0..1000)
    torque = Kt * duty/1000  ->  Newton revolute joint
    omega  <- Newton joint velocity
    sysbus WriteDoubleWord TIM3.CNT (omega x100)  -> firmware feedback
    emulation RunFor <dt>                          (virtual time, deterministic)

State stream lands in FLUX_SIM_STATE (JSON) for sim_probe assertions and in
stdout as JSON lines (one per step) for live plotting.
"""
from __future__ import annotations

import argparse
import json
import os
import socket
import time
from pathlib import Path

# STM32F103 addresses (from the register-map asset; see firmware/motor_pid/main.c)
TIM1_CCR1 = 0x40012C34
TIM3_CNT = 0x40000424

STATE_PATH = Path(os.environ.get(
    "FLUX_SIM_STATE",
    os.path.join(os.path.expanduser(os.environ.get("FLUX_HOME", "~/.flux")), "sim", "state.json"),
))


class RenodeMonitor:
    """Minimal telnet client for Renode's monitor (prompt-synchronized)."""

    def __init__(self, host: str = "127.0.0.1", port: int = 3456) -> None:
        self.sock = socket.create_connection((host, port), timeout=10)
        self.sock.settimeout(15)
        self.cmd("")  # poke: late-joining clients get no banner, elicit a prompt

    def cmd(self, command: str) -> str:
        self.sock.sendall((command + "\n").encode())
        buf = b""
        while True:
            buf += self.sock.recv(4096)
            text = buf.decode(errors="replace")
            clean = "".join(ch for ch in text if ch >= " " or ch in "\r\n")
            import re
            clean = re.sub(r"\x1b\[[0-9;]*m", "", text)
            clean = re.sub(r"[^\x20-\x7e\r\n]", "", clean)
            if re.search(r"\(\S+\)\s*$", clean):
                return clean.replace(command, "", 1)

    def read_u32(self, addr: int) -> int:
        out = self.cmd(f"sysbus ReadDoubleWord 0x{addr:08X}")
        import re
        m = re.findall(r"0x[0-9a-fA-F]+", out.replace(f"0x{addr:08X}", "", 1))
        return int(m[0], 16) if m else 0

    def write_u32(self, addr: int, value: int) -> None:
        self.cmd(f"sysbus WriteDoubleWord 0x{addr:08X} 0x{value & 0xFFFFFFFF:08X}")

    def run_for(self, seconds: float) -> None:
        self.cmd(f'emulation RunFor "{seconds}"')


class MotorSim:
    """Newton articulation: motor rotor on a single revolute joint (viscous load).

    Runs on CPU — a 1-dof articulation gains nothing from CUDA and the CPU
    path keeps the lockstep deterministic and allocation-free.
    """

    def __init__(self, kt: float = 0.12, damping: float = 0.008) -> None:
        import warp as wp
        import newton

        self.kt = kt
        wp.init()
        with wp.ScopedDevice("cpu"):
            builder = newton.ModelBuilder()
            rotor = builder.add_link(mass=0.4)
            builder.add_shape_capsule(rotor, radius=0.02, half_height=0.15)
            joint = builder.add_joint_revolute(
                parent=-1, child=rotor, axis=(0.0, 0.0, 1.0),
                target_ke=0.0, target_kd=damping,  # kd toward qd-target 0 == viscous friction
            )
            builder.add_articulation([joint])
            self.model = builder.finalize()
            self.solver = newton.solvers.SolverFeatherstone(self.model)
            self.state0, self.state1 = self.model.state(), self.model.state()
            self.control = self.model.control()
        self.dt = 1.0 / 1000.0

    def step(self, duty: int, substeps: int = 5) -> float:
        """Apply firmware duty (0..1000) as joint torque; return joint velocity [rad/s]."""
        f = self.control.joint_f.numpy()
        f[0] = self.kt * (duty / 1000.0)
        self.control.joint_f.assign(f)
        for _ in range(substeps):
            self.state0.clear_forces()
            self.solver.step(self.state0, self.state1, self.control, None, self.dt)
            self.state0, self.state1 = self.state1, self.state0
        return float(self.state0.joint_qd.numpy()[0])


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--steps", type=int, default=400)
    ap.add_argument("--port", type=int, default=int(os.environ.get("FLUX_RENODE_PORT", 3456)))
    ap.add_argument("--dt", type=float, default=0.005, help="virtual firmware time per lockstep")
    args = ap.parse_args()

    mon = RenodeMonitor(port=args.port)
    mon.cmd("pause")  # take over time: lockstep RunFor only, deterministic
    sim = MotorSim()
    STATE_PATH.parent.mkdir(parents=True, exist_ok=True)

    omega = 0.0
    history: list[dict[str, float]] = []
    for i in range(args.steps):
        duty = mon.read_u32(TIM1_CCR1)
        omega = sim.step(duty)
        mon.write_u32(TIM3_CNT, int(omega * 100))
        mon.run_for(args.dt)
        rec = {"t": round(i * args.dt, 4), "duty": duty, "motor.velocity": round(omega, 4)}
        history.append(rec)
        print(json.dumps(rec), flush=True)

    tail = [h["motor.velocity"] for h in history[-50:]]
    state = {
        "quantities": {
            "motor.velocity": history[-1]["motor.velocity"],
            "motor.velocity.settled_mean": round(sum(tail) / len(tail), 4),
            "motor.duty": history[-1]["duty"],
        },
        "steps": len(history),
        "history_tail": history[-20:],
    }
    STATE_PATH.write_text(json.dumps(state, indent=2))
    print(f"# state written: {STATE_PATH}", flush=True)


if __name__ == "__main__":
    main()
