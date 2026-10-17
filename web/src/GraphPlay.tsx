import { useEffect, useRef, useState } from "react";
import type { GraphApi } from "./fx/graph2d";

/** The memory graph to play with: run a session, change a fact, drag the nodes. */
export function GraphPlay() {
  const canvas = useRef<HTMLCanvasElement>(null);
  const api = useRef<GraphApi | null>(null);
  const [said, setSaid] = useState("Drag a block. Run a session to watch it recall and learn.");

  useEffect(() => {
    let live = true;
    void import("./fx/graph2d").then(({ createGraph }) => {
      if (!live || !canvas.current) return;
      api.current = createGraph(canvas.current, { reduced: matchMedia("(prefers-reduced-motion: reduce)").matches });
    });
    return () => {
      live = false;
      api.current?.destroy();
      api.current = null;
    };
  }, []);

  return (
    <div className="play" data-reveal="">
      <div className="play-bar">
        <span className="play-title">memory.journal · live</span>
        <span className="play-legend" aria-hidden="true">
          <i className="k-session" />session <i className="k-fact" />fact <i className="k-pitfall" />pitfall <i className="k-skill" />skill <i className="k-open" />open
        </span>
      </div>
      <canvas ref={canvas} className="play-canvas" role="img" aria-label="A memory graph for one project: facts, a pitfall with its fix, a skill and past sessions, linked to the project. Run a session or change a fact with the buttons below." />
      <div className="play-actions">
        <button type="button" className="btn" onClick={() => api.current && setSaid(api.current.newSession())}>Run a session</button>
        <button type="button" className="btn alt" onClick={() => api.current && setSaid(api.current.changeFact())}>Change a fact</button>
        <p className="play-said" aria-live="polite">{said}</p>
      </div>
    </div>
  );
}
