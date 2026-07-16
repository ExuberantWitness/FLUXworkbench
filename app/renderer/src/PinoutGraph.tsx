// PinoutGraph — interactive MCU↔device wiring diagram for verifying a parsed
// PCB. MCU pins on the left, board devices on the right, edges = the nets that
// connect them (from the netlist). Click a pin OR a device to focus its
// connections; click empty space to clear. Pure SVG, theme-aware, no deps.
import React, { useMemo, useState } from "react";
import { useLang } from "./i18n";

interface DeviceMapRow { gpio: string; function: string; signal: string; net: string; connects_to: string[] }

// function → accent color (matches the pin-classification in pcb_ingest).
const FUNC_COLOR: Record<string, string> = {
  i2c: "#7c3aed", uart: "#0e7490", adc: "#b45309", "timer/pwm": "#c2410c",
  spi: "#4338ca", debug: "#6b7280", wakeup: "#0891b2", "gpio/led": "#16a34a",
  gpio: "#2563eb", other: "#64748b",
};
const colorOf = (fn: string): string => FUNC_COLOR[fn] ?? FUNC_COLOR["other"]!;

interface Edge { pinId: string; devRef: string }

export function PinoutGraph({ deviceMap, mcu }: { deviceMap: DeviceMapRow[]; mcu: string }): React.ReactElement {
  const { t } = useLang();
  const [focus, setFocus] = useState<string | null>(null); // pinId or devRef

  const { pins, devices, edges } = useMemo(() => {
    const pins = deviceMap.map((r, i) => ({ id: `p${i}`, gpio: r.gpio, fn: r.function, signal: r.signal, net: r.net }));
    const devMap = new Map<string, { ref: string; part: string }>();
    const edges: Edge[] = [];
    deviceMap.forEach((r, i) => {
      for (const c of r.connects_to) {
        // "MLX90640(U5.1)" → part=MLX90640, ref=U5
        const m = /^(.+?)\(([A-Za-z]+\d+)\.[\w]+\)$/.exec(c);
        const ref = m ? m[2]! : c;
        const part = m ? m[1]! : c;
        if (!devMap.has(ref)) devMap.set(ref, { ref, part });
        edges.push({ pinId: `p${i}`, devRef: ref });
      }
    });
    return { pins, devices: [...devMap.values()], edges };
  }, [deviceMap]);

  const rows = Math.max(pins.length, devices.length);
  const W = 460, rowH = 30, padTop = 34, H = padTop + rows * rowH + 16;
  const PIN_X = 150, DEV_X = 320, MCU_X = 12, PIN_W = 128, DEV_W = 128;
  const pinY = (i: number): number => padTop + i * rowH + 10;
  const devY = (i: number): number => padTop + i * rowH + 10;
  const devIndex = new Map(devices.map((d, i) => [d.ref, i]));

  // which edges/nodes are lit under the current focus
  const lit = (e: Edge): boolean => !focus || e.pinId === focus || e.devRef === focus;
  const pinLit = (id: string): boolean => !focus || focus === id || edges.some((e) => e.pinId === id && e.devRef === focus);
  const devLit = (ref: string): boolean => !focus || focus === ref || edges.some((e) => e.devRef === ref && e.pinId === focus);

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
        <span style={{ fontSize: 11.5, fontWeight: 700, color: "var(--grey-3)" }}>{t("pcb.graphHead")}</span>
        {focus && <button className="ft-btn" onClick={() => setFocus(null)}>✕ {t("pcb.clearFocus")}</button>}
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", display: "block" }} onClick={() => setFocus(null)}>
        {/* MCU spine */}
        <rect x={MCU_X} y={padTop - 4} width={20} height={rows * rowH} rx={4}
          fill="rgba(0,47,167,.08)" stroke="var(--accent)" />
        <text x={MCU_X + 10} y={padTop + rows * rowH / 2} textAnchor="middle" fontSize={9}
          fill="var(--accent)" fontWeight={700} transform={`rotate(-90 ${MCU_X + 10} ${padTop + rows * rowH / 2})`}>
          {mcu}
        </text>

        {/* edges: pin → device */}
        {edges.map((e, i) => {
          const pi = pins.findIndex((p) => p.id === e.pinId);
          const di = devIndex.get(e.devRef) ?? 0;
          const y1 = pinY(pi), y2 = devY(di);
          const on = lit(e);
          const c = colorOf(pins[pi]?.fn ?? "other");
          return (
            <path key={i} d={`M ${PIN_X + PIN_W} ${y1} C ${(PIN_X + PIN_W + DEV_X) / 2} ${y1}, ${(PIN_X + PIN_W + DEV_X) / 2} ${y2}, ${DEV_X} ${y2}`}
              fill="none" stroke={on ? c : "var(--grey-2)"} strokeWidth={on ? 1.8 : 0.8} opacity={on ? 0.9 : 0.25} />
          );
        })}
        {/* MCU→pin stubs */}
        {pins.map((p, i) => (
          <line key={p.id} x1={MCU_X + 20} y1={pinY(i)} x2={PIN_X} y2={pinY(i)}
            stroke={pinLit(p.id) ? colorOf(p.fn) : "var(--grey-2)"} strokeWidth={pinLit(p.id) ? 1.5 : 0.8}
            opacity={pinLit(p.id) ? 0.9 : 0.3} />
        ))}

        {/* pin nodes (left) */}
        {pins.map((p, i) => (
          <g key={p.id} style={{ cursor: "pointer" }}
            onClick={(ev) => { ev.stopPropagation(); setFocus(focus === p.id ? null : p.id); }}>
            <rect x={PIN_X} y={pinY(i) - 9} width={PIN_W} height={18} rx={4}
              fill={pinLit(p.id) ? "var(--paper)" : "var(--grey-1)"}
              stroke={pinLit(p.id) ? colorOf(p.fn) : "var(--grey-2)"} strokeWidth={focus === p.id ? 2 : 1} />
            <circle cx={PIN_X + 8} cy={pinY(i)} r={3} fill={colorOf(p.fn)} opacity={pinLit(p.id) ? 1 : 0.4} />
            <text x={PIN_X + 16} y={pinY(i) + 3} fontSize={9.5} fontFamily="var(--mono)"
              fill={pinLit(p.id) ? "var(--ink)" : "var(--grey-3)"} fontWeight={600}>{p.gpio}</text>
            <text x={PIN_X + PIN_W - 6} y={pinY(i) + 3} fontSize={7.5} textAnchor="end"
              fill="var(--grey-3)">{p.fn}</text>
          </g>
        ))}

        {/* device nodes (right) */}
        {devices.map((d, i) => (
          <g key={d.ref} style={{ cursor: "pointer" }}
            onClick={(ev) => { ev.stopPropagation(); setFocus(focus === d.ref ? null : d.ref); }}>
            <rect x={DEV_X} y={devY(i) - 10} width={DEV_W} height={20} rx={4}
              fill={devLit(d.ref) ? "rgba(0,47,167,.05)" : "var(--grey-1)"}
              stroke={devLit(d.ref) ? "var(--accent)" : "var(--grey-2)"} strokeWidth={focus === d.ref ? 2 : 1} />
            <text x={DEV_X + 8} y={devY(i) + 3.5} fontSize={9.5} fontFamily="var(--mono)"
              fill={devLit(d.ref) ? "var(--ink)" : "var(--grey-3)"} fontWeight={600}>
              {d.part.length > 14 ? d.part.slice(0, 13) + "…" : d.part}
            </text>
            <text x={DEV_X + DEV_W - 6} y={devY(i) + 3.5} fontSize={8} textAnchor="end" fill="var(--grey-3)">{d.ref}</text>
          </g>
        ))}
      </svg>
      <div style={{ fontSize: 10, color: "var(--grey-3)", marginTop: 4 }}>{t("pcb.graphHint")}</div>
    </div>
  );
}
