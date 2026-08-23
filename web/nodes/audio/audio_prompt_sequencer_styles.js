const STYLE_ID = "fl-beat-prompt-sequencer-styles";

const STYLES = `
  .flbps-root {
    height: 100%;
    min-height: 0;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    color: #e4e4e7;
    background: #151518;
    border: 1px solid #303036;
    border-radius: 10px;
    font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    box-sizing: border-box;
  }
  .flbps-root * { box-sizing: border-box; }
  .flbps-root:focus { outline: none; }
  .flbps-root:focus-visible { outline: 1px solid #525762; outline-offset: -1px; }
  .flbps-toolbar, .flbps-actions, .flbps-footer {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 7px 9px;
    border-bottom: 1px solid #2b2b31;
    background: #1c1c20;
  }
  .flbps-status {
    max-width: 390px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    padding: 4px 8px;
    border-radius: 10px;
    color: #a1a1aa;
    background: #27272a;
    font-size: 9px;
  }
  .flbps-status.fresh { color: #d1fae5; background: #065f46; }
  .flbps-status.cached { color: #fef3c7; background: #713f12; }
  .flbps-status.error { color: #fee2e2; background: #7f1d1d; }
  .flbps-status.loading {
    color: #dbeafe;
    background: linear-gradient(90deg, #1d4ed8 var(--flbps-progress, 0%), #172554 var(--flbps-progress, 0%));
  }
  .flbps-marker-legend {
    display: flex;
    align-items: center;
    gap: 9px;
    color: #a1a1aa;
    font-size: 8px;
    white-space: nowrap;
  }
  .flbps-marker-legend b { font-size: 11px; line-height: 1; }
  .flbps-marker-beat { color: #67e8f9; }
  .flbps-marker-downbeat { color: #fbbf24; }
  .flbps-marker-model { color: #e879f9; }
  .flbps-marker-onset { color: #fb923c; }
  .flbps-toolbar {
    flex-wrap: wrap;
    gap: 8px;
    padding-top: 6px;
    padding-bottom: 6px;
    background: #17191e;
  }
  .flbps-control-group { display: flex; align-items: center; gap: 7px; }
  .flbps-toolbar-divider { width: 1px; height: 20px; background: #343740; }
  .flbps-transport {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 6px 9px;
    border-bottom: 1px solid #2b2b31;
    background: #18181c;
  }
  .flbps-transport-time {
    min-width: 105px;
    color: #fbbf24;
    font: 10px "Cascadia Mono", Consolas, monospace;
  }
  .flbps-volume {
    display: flex;
    align-items: center;
    gap: 5px;
    padding: 2px 6px;
    color: #a1a1aa;
    background: #202024;
    border: 1px solid #34343a;
    border-radius: 12px;
  }
  .flbps-volume-icon {
    width: 14px;
    flex: 0 0 14px;
    filter: grayscale(1);
    font-size: 11px;
    line-height: 1;
    text-align: center;
  }
  .flbps-volume input[type="range"] {
    --flbps-volume-position: 100%;
    width: 72px;
    height: 16px;
    margin: 0;
    padding: 0;
    appearance: none;
    background: transparent;
    cursor: pointer;
  }
  .flbps-volume input[type="range"]::-webkit-slider-runnable-track {
    height: 4px;
    background: linear-gradient(90deg, #67e8f9 0 var(--flbps-volume-position), #45454e var(--flbps-volume-position) 100%);
    border-radius: 2px;
  }
  .flbps-volume input[type="range"]::-webkit-slider-thumb {
    width: 14px;
    height: 14px;
    margin-top: -5px;
    appearance: none;
    background: #f4f4f5;
    border: 2px solid #0891b2;
    border-radius: 50%;
    box-shadow: 0 1px 4px rgba(0, 0, 0, .55);
  }
  .flbps-volume input[type="range"]::-moz-range-track {
    height: 4px;
    background: linear-gradient(90deg, #67e8f9 0 var(--flbps-volume-position), #45454e var(--flbps-volume-position) 100%);
    border: 0;
    border-radius: 2px;
  }
  .flbps-volume input[type="range"]::-moz-range-thumb {
    width: 11px;
    height: 11px;
    background: #f4f4f5;
    border: 2px solid #0891b2;
    border-radius: 50%;
    box-shadow: 0 1px 4px rgba(0, 0, 0, .55);
  }
  .flbps-volume input[type="range"]:focus-visible { outline: 1px solid #67e8f9; outline-offset: 2px; }
  .flbps-volume-value {
    min-width: 30px;
    color: #d4d4d8;
    font: 8px "Cascadia Mono", Consolas, monospace;
    text-align: right;
  }
  .flbps-source-label {
    min-width: 0;
    overflow: hidden;
    color: #a1a1aa;
    font-size: 9px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .flbps-auto {
    display: flex;
    align-items: center;
    gap: 4px;
    color: #a1a1aa;
    font-size: 9px;
  }
  .flbps-control {
    display: flex;
    align-items: center;
    gap: 4px;
    color: #a1a1aa;
    font-size: 9px;
  }
  .flbps-control select, .flbps-control input[type="number"], .flbps-inspector input,
  .flbps-inspector textarea, .flbps-raw textarea {
    color: #f4f4f5;
    background: #252529;
    border: 1px solid #3f3f46;
    border-radius: 5px;
    outline: none;
    font: inherit;
  }
  .flbps-control select {
    height: 23px;
    min-width: 66px;
    padding: 2px 5px;
    font-size: 9px;
  }
  .flbps-control input[type="range"] {
    width: 110px;
    accent-color: #22d3ee;
  }
  .flbps-control input[type="number"] {
    width: 62px;
    height: 23px;
    padding: 2px 4px;
    font-size: 9px;
    text-align: right;
  }
  .flbps-offset-frames {
    min-width: 66px;
    color: #67e8f9;
    font: 9px "Cascadia Mono", Consolas, monospace;
  }
  .flbps-control select:focus, .flbps-control input[type="number"]:focus, .flbps-inspector input:focus,
  .flbps-inspector textarea:focus, .flbps-raw textarea:focus { border-color: #22d3ee; }
  .flbps-canvas-wrap {
    position: relative;
    height: clamp(356px, 50vh, 476px);
    flex: 0 1 448px;
    min-height: 336px;
    overflow: hidden;
    background: #101013;
  }
  .flbps-canvas { width: 100%; height: 100%; display: block; touch-action: none; }
  .flbps-song-label-editor {
    position: absolute;
    z-index: 2;
    box-sizing: border-box;
    margin: 0;
    padding: 2px 5px;
    color: #f8fafc;
    background: #17202b;
    border: 1px solid #67e8f9;
    border-radius: 3px;
    outline: none;
    box-shadow: 0 0 0 2px rgba(34,211,238,.16);
    font: 600 9px Inter, sans-serif;
  }
  .flbps-song-label-editor[hidden] { display: none; }
  .flbps-empty {
    position: absolute;
    left: 50%;
    top: 58%;
    transform: translate(-50%, -50%);
    color: #71717a;
    font-size: 11px;
    pointer-events: none;
  }
  .flbps-actions {
    border-top: 1px solid #2b2b31;
    border-bottom: 1px solid #2b2b31;
  }
  .flbps-lane-badge {
    min-width: 76px;
    padding: 3px 7px;
    color: #c4b5fd;
    background: #27233a;
    border: 1px solid #4c4368;
    border-radius: 10px;
    font-size: 8px;
    font-weight: 700;
    text-align: center;
    text-transform: uppercase;
  }
  .flbps-root[data-active-lane="song-map"] .flbps-lane-badge {
    color: #a5f3fc;
    background: #12353d;
    border-color: #155e75;
  }
  .flbps-root[data-active-lane="lyrics"] .flbps-lane-badge {
    color: #f5d0fe;
    background: #3b1f4a;
    border-color: #7e22ce;
  }
  .flbps-button {
    height: 24px;
    padding: 3px 8px;
    color: #d4d4d8;
    background: #27272a;
    border: 1px solid #3f3f46;
    border-radius: 5px;
    font-size: 9px;
    cursor: pointer;
    transition: color .1s ease, background .1s ease, border-color .1s ease, opacity .1s ease;
  }
  .flbps-button:hover { color: #fff; border-color: #52525b; background: #303036; }
  .flbps-button.primary { color: #ecfeff; border-color: #0e7490; background: #155e75; }
  .flbps-button.active { color: #cffafe; border-color: #0891b2; background: #164e63; }
  .flbps-button.danger:hover { border-color: #b91c1c; background: #7f1d1d; }
  .flbps-button:disabled { opacity: .4; cursor: default; }
  .flbps-writer-toggle {
    max-width: 270px;
    display: inline-flex;
    align-items: center;
    gap: 5px;
    overflow: hidden;
    white-space: nowrap;
  }
  .flbps-writer-toggle-indicator {
    width: 8px;
    height: 8px;
    flex: 0 0 8px;
    display: grid;
    place-items: center;
    color: #a7f3d0;
    background: #52525b;
    border-radius: 50%;
    font-size: 7px;
    font-style: normal;
    font-weight: 800;
    line-height: 1;
  }
  .flbps-writer-toggle small {
    min-width: 0;
    overflow: hidden;
    color: #7dd3fc;
    font-size: 8px;
    text-overflow: ellipsis;
  }
  .flbps-writer-toggle.writer-running {
    color: #e0f2fe;
    background: rgba(8, 47, 73, .88);
    border-color: #0e7490;
    box-shadow: 0 0 0 1px rgba(34, 211, 238, .08), 0 0 18px rgba(14, 116, 144, .2);
  }
  .flbps-writer-toggle.writer-running .flbps-writer-toggle-indicator {
    background: transparent;
    border: 2px solid rgba(125, 211, 252, .28);
    border-top-color: #67e8f9;
    animation: flbps-writer-spin .75s linear infinite;
  }
  .flbps-writer-toggle[data-writer-state="applied"],
  .flbps-writer-toggle[data-writer-state="complete"],
  .flbps-writer-toggle[data-writer-state="no_changes"] {
    color: #d1fae5;
    background: rgba(6, 78, 59, .72);
    border-color: #059669;
  }
  .flbps-writer-toggle[data-writer-state="applied"] small,
  .flbps-writer-toggle[data-writer-state="complete"] small,
  .flbps-writer-toggle[data-writer-state="no_changes"] small { color: #a7f3d0; }
  .flbps-writer-toggle[data-writer-state="applied"] .flbps-writer-toggle-indicator,
  .flbps-writer-toggle[data-writer-state="complete"] .flbps-writer-toggle-indicator,
  .flbps-writer-toggle[data-writer-state="no_changes"] .flbps-writer-toggle-indicator { background: #047857; }
  .flbps-writer-toggle[data-writer-state="error"] {
    color: #fff7ed;
    background: rgba(120, 53, 15, .76);
    border-color: #d97706;
  }
  .flbps-writer-toggle[data-writer-state="error"] small { color: #fde68a; }
  .flbps-writer-toggle[data-writer-state="error"] .flbps-writer-toggle-indicator { color: #451a03; background: #fbbf24; }
  .flbps-spacer { flex: 1; }
  .flbps-inspector-tabs { display: none; padding: 6px 8px 0; background: #17171b; }
  .flbps-inspector-tabs .flbps-button { flex: 1; }
  .flbps-inspector {
    flex: 1 1 260px;
    min-height: 220px;
    display: grid;
    grid-template-columns: minmax(280px, 0.36fr) minmax(520px, 0.64fr);
    gap: 8px;
    padding: 8px;
    overflow: hidden;
    background: #141417;
    border-bottom: 1px solid #2b2b31;
  }
  .flbps-clip-inspector, .flbps-song-inspector, .flbps-lyrics-inspector, .flbps-envelope-panel {
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
    padding: 8px;
    overflow: hidden;
    background: #19191d;
    border: 1px solid #2f2f35;
    border-radius: 7px;
  }
  .flbps-clip-inspector.disabled, .flbps-song-inspector.disabled { opacity: 0.45; pointer-events: none; }
  .flbps-inspector[data-lane="prompt"] .flbps-song-inspector,
  .flbps-inspector[data-lane="prompt"] .flbps-lyrics-inspector { display: none; }
  .flbps-inspector[data-lane="song-map"] .flbps-clip-inspector,
  .flbps-inspector[data-lane="song-map"] .flbps-lyrics-inspector { display: none; }
  .flbps-inspector[data-lane="lyrics"] .flbps-clip-inspector,
  .flbps-inspector[data-lane="lyrics"] .flbps-song-inspector { display: none; }
  .flbps-inspector-grid {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 6px;
    margin-bottom: 7px;
  }
  .flbps-field { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
  .flbps-field label { color: #8b8b95; font-size: 8px; text-transform: uppercase; letter-spacing: .04em; }
  .flbps-field input { width: 100%; height: 24px; padding: 3px 5px; font-size: 10px; }
  .flbps-field select { width: 100%; height: 24px; padding: 3px 5px; color: #f4f4f5; background: #252529; border: 1px solid #3f3f46; border-radius: 5px; font-size: 10px; }
  .flbps-prompt-label {
    display: flex;
    justify-content: space-between;
    gap: 8px;
    margin-bottom: 4px;
    color: #8b8b95;
    font-size: 8px;
    text-transform: uppercase;
    letter-spacing: .04em;
  }
  .flbps-prompt-meta {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: #c4b5fd;
    text-transform: none;
    letter-spacing: 0;
  }
  .flbps-inspector textarea {
    width: 100%;
    min-height: 68px;
    flex: 1 1 auto;
    resize: vertical;
    padding: 7px;
    font-size: 10px;
    line-height: 1.4;
  }
  .flbps-lyrics-controls {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-top: 7px;
  }
  .flbps-lyrics-status {
    margin-top: 6px;
    padding: 5px 7px;
    color: #a1a1aa;
    background: #202024;
    border: 1px solid #34343a;
    border-radius: 5px;
    font-size: 8px;
    line-height: 1.35;
  }
  .flbps-lyrics-status.ready { color: #d8b4fe; border-color: #6b21a8; background: #2e1738; }
  .flbps-lyrics-status.warning { color: #fed7aa; border-color: #9a3412; background: #3b2116; }
  .flbps-song-summary {
    min-height: 52px;
    padding: 8px;
    color: #a1a1aa;
    background: #15171c;
    border: 1px solid #2f333b;
    border-radius: 5px;
    font-size: 9px;
    line-height: 1.5;
  }
  .flbps-song-reset-actions { display: flex; gap: 6px; margin-top: auto; padding-top: 7px; }
  .flbps-envelope-header, .flbps-envelope-card-header, .flbps-envelope-preview-row {
    display: flex;
    align-items: center;
    gap: 7px;
  }
  .flbps-envelope-header { min-height: 25px; margin-bottom: 6px; }
  .flbps-envelope-title {
    color: #d4d4d8;
    font-size: 8px;
    font-weight: 700;
    letter-spacing: .05em;
    text-transform: uppercase;
  }
  .flbps-envelope-limit {
    padding: 2px 5px;
    color: #a1a1aa;
    background: #27272a;
    border-radius: 8px;
    font-size: 7px;
  }
  .flbps-envelope-cards {
    flex: 1 1 auto;
    min-height: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
    overflow: auto;
  }
  .flbps-envelope-card, .flbps-envelope-empty {
    flex: 1 1 0;
    min-height: 126px;
    padding: 6px;
    background: #151519;
    border: 1px solid #34343b;
    border-left: 3px solid var(--flbps-envelope-accent, #22d3ee);
    border-radius: 6px;
  }
  .flbps-envelope-card.disabled { opacity: .58; }
  .flbps-envelope-empty {
    display: flex;
    align-items: center;
    justify-content: center;
    border-style: dashed;
  }
  .flbps-envelope-empty .flbps-button { min-width: 112px; }
  .flbps-envelope-card-header { min-height: 24px; }
  .flbps-envelope-card-name { color: #f4f4f5; font-size: 9px; font-weight: 600; }
  .flbps-envelope-enabled { width: 14px; height: 14px; accent-color: #22d3ee; }
  .flbps-envelope-source {
    height: 23px;
    min-width: 92px;
    padding: 2px 5px;
    color: #f4f4f5;
    background: #252529;
    border: 1px solid #3f3f46;
    border-radius: 5px;
    font-size: 8px;
  }
  .flbps-envelope-icon { min-width: 25px; width: 25px; padding: 2px; }
  .flbps-envelope-prompt {
    width: 100%;
    min-height: 29px !important;
    height: 29px;
    margin: 4px 0;
    flex: 0 0 auto !important;
    resize: none !important;
    padding: 5px 6px !important;
    font-size: 9px !important;
  }
  .flbps-envelope-controls {
    display: grid;
    grid-template-columns: repeat(8, minmax(44px, 1fr));
    gap: 4px;
    margin-bottom: 5px;
  }
  .flbps-envelope-control { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .flbps-envelope-control label {
    overflow: hidden;
    color: #777781;
    font-size: 7px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .flbps-envelope-control input, .flbps-envelope-control select {
    width: 100%;
    height: 22px;
    padding: 2px 4px;
    color: #f4f4f5;
    background: #222226;
    border: 1px solid #393940;
    border-radius: 4px;
    font-size: 8px;
  }
  .flbps-envelope-preview-row { min-height: 37px; }
  .flbps-envelope-strip-wrap {
    min-width: 0;
    flex: 1 1 auto;
    height: 34px;
    position: relative;
    overflow: hidden;
    background: #050506;
    border: 1px solid #34343b;
    border-radius: 4px;
  }
  .flbps-envelope-strip { width: 100%; height: 100%; display: block; cursor: pointer; }
  .flbps-envelope-playhead {
    display: none;
    width: 1px;
    position: absolute;
    inset: 0 auto 0 0;
    background: #22d3ee;
    box-shadow: 0 0 4px rgba(34,211,238,.8);
    pointer-events: none;
  }
  .flbps-envelope-live {
    width: 34px;
    height: 34px;
    flex: 0 0 34px;
    background: #000;
    border: 1px solid #45454e;
    border-radius: 4px;
  }
  .flbps-envelope-value {
    width: 72px;
    flex: 0 0 72px;
    color: #a1a1aa;
    font: 7px "Cascadia Mono", Consolas, monospace;
    line-height: 1.35;
  }
  .flbps-raw { display: none; flex: 0 0 auto; padding: 8px 9px; background: #17171a; border-bottom: 1px solid #2b2b31; }
  .flbps-raw.open { display: block; }
  .flbps-raw-label { margin-bottom: 5px; color: #a1a1aa; font-size: 9px; }
  .flbps-raw textarea { width: 100%; height: 130px; resize: vertical; padding: 7px; font-family: "Cascadia Mono", Consolas, monospace; font-size: 9px; line-height: 1.35; }
  .flbps-raw-actions { display: flex; gap: 6px; margin-top: 6px; justify-content: flex-end; }
  .flbps-footer {
    justify-content: flex-end;
    border-bottom: 0;
    color: #71717a;
    font-size: 8px;
  }
  .flbps-error {
    display: none;
    flex: 0 0 auto;
    padding: 6px 9px;
    color: #fecaca;
    background: #450a0a;
    border-bottom: 1px solid #7f1d1d;
    font-size: 9px;
  }
  .flbps-error.open { display: block; }
  .flbps-context-menu {
    position: fixed;
    z-index: 10020;
    min-width: 220px;
    padding: 5px;
    color: #e4e4e7;
    background: #202127;
    border: 1px solid #555b68;
    border-radius: 7px;
    box-shadow: 0 14px 38px rgba(0, 0, 0, .58);
    font: 10px Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  }
  .flbps-context-title {
    padding: 5px 7px 6px;
    color: #8ddde8;
    border-bottom: 1px solid #363a43;
    font: 9px "Cascadia Mono", Consolas, monospace;
  }
  .flbps-context-menu button {
    width: 100%;
    display: block;
    padding: 7px;
    color: #e4e4e7;
    background: transparent;
    border: 0;
    border-radius: 4px;
    font: inherit;
    text-align: left;
    cursor: pointer;
  }
  .flbps-context-menu button:hover { color: #fff; background: #343844; }
  .flbps-context-menu button:disabled { color: #646975; cursor: default; }
  .flbps-context-menu button:disabled:hover { background: transparent; }
  .flbps-modal-overlay {
    position: fixed;
    inset: 0;
    z-index: 10000;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 2.5vh 2.5vw;
    background: rgba(0, 0, 0, .84);
    backdrop-filter: blur(4px);
    animation: flbps-fade-in .15s ease-out;
  }
  .flbps-modal-shell {
    width: 95vw;
    height: 94vh;
    max-width: 1900px;
    max-height: 1400px;
    min-width: 760px;
    min-height: 600px;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    color: #e4e4e7;
    background: #111114;
    border: 1px solid #3f3f46;
    border-radius: 12px;
    box-shadow: 0 24px 80px rgba(0, 0, 0, .72);
    font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    animation: flbps-modal-in .18s ease-out;
  }
  .flbps-modal-header {
    flex: 0 0 auto;
    min-height: 52px;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 9px 12px 9px 16px;
    background: #1b1b20;
    border-bottom: 1px solid #303036;
  }
  .flbps-modal-heading { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
  .flbps-modal-title { color: #fafafa; font-size: 14px; font-weight: 700; }
  .flbps-modal-subtitle {
    max-width: 62vw;
    overflow: hidden;
    color: #a1a1aa;
    font-size: 10px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .flbps-history-controls {
    display: flex;
    align-items: center;
    gap: 5px;
  }
  .flbps-history-controls .flbps-button { min-width: 48px; }
  .flbps-modal-main { flex: 1 1 auto; min-height: 0; display: flex; }
  .flbps-library {
    width: 310px;
    flex: 0 0 310px;
    min-height: 0;
    position: relative;
    display: flex;
    flex-direction: column;
    gap: 9px;
    padding: 11px;
    overflow: visible;
    background: #17171b;
    border-right: 1px solid #303036;
    transition: width .16s ease, flex-basis .16s ease, padding .16s ease;
  }
  .flbps-library > :not(.flbps-sidebar-toggle) {
    transition: opacity .1s ease, visibility .1s ease;
  }
  .flbps-modal-shell.library-collapsed .flbps-library {
    width: 14px;
    flex-basis: 14px;
    gap: 0;
    padding: 0;
  }
  .flbps-modal-shell.library-collapsed .flbps-library > :not(.flbps-sidebar-toggle) {
    opacity: 0;
    visibility: hidden;
    pointer-events: none;
  }
  .flbps-library-section { flex: 0 0 auto; display: flex; flex-direction: column; gap: 6px; }
  .flbps-library-label {
    color: #8b8b95;
    font-size: 8px;
    font-weight: 700;
    letter-spacing: .06em;
    text-transform: uppercase;
  }
  .flbps-drop-zone {
    min-height: 70px;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 10px;
    color: #a1a1aa;
    background: #202027;
    border: 1px dashed #52525b;
    border-radius: 7px;
    font-size: 10px;
    line-height: 1.4;
    text-align: center;
    cursor: pointer;
  }
  .flbps-drop-zone.dragging { color: #cffafe; background: #164e63; border-color: #22d3ee; }
  .flbps-library-actions, .flbps-library-tabs { display: flex; gap: 6px; }
  .flbps-library-actions .flbps-button, .flbps-library-tabs .flbps-button { flex: 1; }
  .flbps-library-search, .flbps-library-folder, .flbps-setting input, .flbps-setting select {
    width: 100%;
    height: 28px;
    padding: 4px 7px;
    color: #f4f4f5;
    background: #252529;
    border: 1px solid #3f3f46;
    border-radius: 5px;
    outline: none;
    font: inherit;
    font-size: 10px;
  }
  .flbps-library-search:focus, .flbps-library-folder:focus,
  .flbps-setting input:focus, .flbps-setting select:focus { border-color: #22d3ee; }
  .flbps-library-results {
    flex: 1 1 180px;
    min-height: 120px;
    overflow: auto;
    background: #121216;
    border: 1px solid #2f2f35;
    border-radius: 6px;
  }
  .flbps-file-row {
    width: 100%;
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 7px 8px;
    color: #d4d4d8;
    background: transparent;
    border: 0;
    border-bottom: 1px solid #25252a;
    font: inherit;
    text-align: left;
    cursor: pointer;
  }
  .flbps-file-row:hover { background: #27272e; }
  .flbps-file-row.selected { color: #cffafe; background: #164e63; }
  .flbps-file-name { overflow: hidden; font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }
  .flbps-file-folder { overflow: hidden; color: #71717a; font-size: 8px; text-overflow: ellipsis; white-space: nowrap; }
  .flbps-library-message { color: #8b8b95; font-size: 9px; line-height: 1.35; }
  .flbps-settings {
    flex: 0 0 auto;
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 7px;
  }
  .flbps-setting { min-width: 0; display: flex; flex-direction: column; gap: 3px; }
  .flbps-setting label { color: #8b8b95; font-size: 8px; }
  .flbps-setting.checkbox { flex-direction: row; align-items: center; padding-top: 15px; }
  .flbps-setting.checkbox input { width: auto; height: auto; }
  .flbps-editor-host { flex: 1 1 auto; min-width: 0; min-height: 0; padding: 8px; }
  .flbps-writer-host {
    width: 0;
    flex: 0 0 0;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
    background: #131317;
    border-left: 0 solid #303036;
    transition: flex-basis .16s ease, width .16s ease;
  }
  .flbps-writer {
    height: 100%;
    min-height: 0;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  }
  .flbps-writer * { box-sizing: border-box; }
  .flbps-writer-chat { position: relative; }
  .flbps-writer-topbar, .flbps-writer-conversation-bar, .flbps-writer-sheet-header,
  .flbps-writer-composer-options { flex: 0 0 auto; display: flex; align-items: center; gap: 7px; }
  .flbps-writer-conversation-bar > span:first-child { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .flbps-writer-view { min-height: 0; flex: 1 1 auto; display: none; flex-direction: column; }
  .flbps-writer-view.active { display: flex; }
  .flbps-writer-messages { flex: 1 1 auto; display: flex; flex-direction: column; overflow: auto; }
  .flbps-writer-sheet-body { min-height: 0; overflow: auto; }
  .flbps-writer-markdown { min-width: 0; }
  .flbps-writer-markdown p:last-child { margin-bottom: 0; }
  .flbps-writer-markdown code { color: #a5f3fc; font-family: Consolas, monospace; }
  .flbps-writer-markdown a { color: #67e8f9; }

  /* Standalone Beat Writer chat */
  .flbps-modal-shell.writer-open .flbps-writer-host { width: 398px; flex-basis: 398px; }
  .flbps-writer {
    --writer-accent: #38bdf8;
    --writer-accent-soft: rgba(56, 189, 248, .14);
    --writer-border: rgba(255, 255, 255, .085);
    --writer-panel: rgba(24, 24, 29, .94);
    width: 398px;
    position: relative;
    isolation: isolate;
    color: #e8e8ec;
    background:
      radial-gradient(circle at 82% -12%, var(--writer-accent-soft), transparent 34%),
      linear-gradient(180deg, #151519 0%, #111114 100%);
    font-size: 10px;
  }
  .flbps-writer[data-provider="claude_subscription"], .flbps-writer[data-provider="anthropic"] { --writer-accent: #f59e72; --writer-accent-soft: rgba(245, 158, 114, .13); }
  .flbps-writer[data-provider="openrouter"] { --writer-accent: #a78bfa; --writer-accent-soft: rgba(167, 139, 250, .14); }
  .flbps-writer[data-provider="ollama"], .flbps-writer[data-provider="lmstudio"] { --writer-accent: #6ee7b7; --writer-accent-soft: rgba(110, 231, 183, .12); }
  .flbps-writer [hidden] { display: none !important; }
  .flbps-writer button, .flbps-writer input, .flbps-writer select, .flbps-writer textarea { font-family: inherit; }
  .flbps-writer button { color: inherit; }
  .flbps-writer button:focus-visible, .flbps-writer input:focus-visible,
  .flbps-writer select:focus-visible, .flbps-writer textarea:focus-visible,
  .flbps-writer summary:focus-visible { outline: 2px solid var(--writer-accent); outline-offset: 2px; }
  .flbps-writer-topbar {
    min-height: 59px;
    padding: 9px 11px;
    background: rgba(24, 24, 29, .78);
    border-bottom: 1px solid var(--writer-border);
    backdrop-filter: blur(14px);
  }
  .flbps-writer-provider {
    min-width: 0;
    flex: 1 1 auto;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px;
    color: #e4e4e7;
    background: transparent;
    border: 0;
    border-radius: 9px;
    text-align: left;
    cursor: pointer;
  }
  .flbps-writer-provider:hover { background: rgba(255, 255, 255, .05); }
  .flbps-writer-provider-mark {
    width: 34px !important;
    height: 34px !important;
    flex: 0 0 34px;
    color: #f8fafc !important;
    background: linear-gradient(145deg, var(--writer-accent), #334155) !important;
    border: 1px solid rgba(255, 255, 255, .2) !important;
    border-radius: 10px !important;
    box-shadow: 0 7px 18px var(--writer-accent-soft), inset 0 1px rgba(255, 255, 255, .22);
    font-size: 9px !important;
    letter-spacing: .04em;
  }
  .flbps-writer-provider-copy { min-width: 0; display: flex; flex-direction: column; gap: 3px; }
  .flbps-writer-brand { display: flex; align-items: center; gap: 6px; color: #fafafa; font-size: 11px; font-weight: 750; letter-spacing: -.01em; }
  .flbps-writer-provider-copy small { max-width: 220px !important; color: #73737e !important; font-size: 7.5px !important; }
  .flbps-writer-provider-copy small strong { color: #a6a6b0; font-size: inherit; font-weight: 600; }
  .flbps-writer-connection-dot { width: 6px; height: 6px; display: inline-block; background: #71717a; border-radius: 50%; box-shadow: 0 0 0 3px rgba(113, 113, 122, .12); }
  .flbps-writer.connected .flbps-writer-connection-dot { background: #34d399; box-shadow: 0 0 0 3px rgba(52, 211, 153, .12), 0 0 9px rgba(52, 211, 153, .38); }
  .flbps-writer-icon-button {
    min-width: 30px;
    height: 30px;
    display: inline-grid;
    place-items: center;
    padding: 0 7px;
    color: #a8a8b2;
    background: rgba(255, 255, 255, .035);
    border: 1px solid var(--writer-border);
    border-radius: 8px;
    font-size: 8px;
    font-weight: 700;
    cursor: pointer;
  }
  .flbps-writer-icon-button:hover { color: #fff; background: rgba(255, 255, 255, .08); border-color: rgba(255, 255, 255, .15); }
  .flbps-writer-menu-wrap { position: relative; }
  .flbps-writer-menu {
    width: 190px;
    position: absolute;
    z-index: 12;
    top: 36px;
    right: 0;
    padding: 5px;
    background: #202026;
    border: 1px solid rgba(255, 255, 255, .11);
    border-radius: 10px;
    box-shadow: 0 18px 45px rgba(0, 0, 0, .48);
    animation: flbps-writer-pop .14s ease-out;
  }
  .flbps-writer-menu button { width: 100%; padding: 8px 9px; background: transparent; border: 0; border-radius: 6px; color: #c5c5cd; font-size: 9px; text-align: left; cursor: pointer; }
  .flbps-writer-menu button:hover { color: #fff; background: rgba(255, 255, 255, .07); }
  .flbps-writer-conversation-bar { min-height: 32px; padding: 5px 12px; background: rgba(17, 17, 20, .68); border-color: var(--writer-border); }
  .flbps-writer-conversation-title { color: #8e8e98; font-size: 8px; font-weight: 600; }
  .flbps-writer-quiet-action { padding: 4px 6px; color: #74747e !important; background: transparent; border: 0; border-radius: 5px; font-size: 7.5px; cursor: pointer; }
  .flbps-writer-quiet-action:hover { color: #d4d4d8 !important; background: rgba(255, 255, 255, .05); }
  .flbps-writer-view { position: relative; }
  .flbps-writer-banner {
    min-height: 29px;
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 6px 12px;
    color: #8a8a94;
    background: rgba(17, 17, 20, .74);
    border-bottom: 1px solid rgba(255, 255, 255, .055);
    font-size: 7.5px;
  }
  .flbps-writer-banner i { width: 5px; height: 5px; flex: 0 0 5px; background: #71717a; border-radius: 50%; }
  .flbps-writer-banner[data-state="ready"] i { background: #34d399; }
  .flbps-writer-banner[data-state="working"] { color: #bae6fd; }
  .flbps-writer-banner[data-state="working"] i { background: var(--writer-accent); box-shadow: 0 0 8px var(--writer-accent); animation: flbps-writer-pulse 1.2s ease-in-out infinite; }
  .flbps-writer-banner[data-state="applied"] { color: #a7f3d0; }
  .flbps-writer-banner[data-state="applied"] i { background: #34d399; }
  .flbps-writer-banner[data-state="error"] { color: #fecaca; background: rgba(127, 29, 29, .22); }
  .flbps-writer-banner[data-state="error"] i { background: #fb7185; }
  .flbps-writer-messages {
    min-height: 0;
    position: relative;
    gap: 0;
    padding: 17px 14px 22px;
    scroll-behavior: smooth;
    background:
      linear-gradient(rgba(255, 255, 255, .018) 1px, transparent 1px),
      linear-gradient(90deg, rgba(255, 255, 255, .014) 1px, transparent 1px);
    background-size: 28px 28px;
    scrollbar-width: thin;
    scrollbar-color: #35353d transparent;
  }
  .flbps-writer-thread { display: flex; flex-direction: column; gap: 18px; }
  .flbps-writer-welcome { max-width: 330px; margin: auto; padding: 22px 4px 14px; text-align: center; animation: flbps-writer-rise .24s ease-out; }
  .flbps-writer-welcome[hidden] { display: none; }
  .flbps-writer-welcome-mark { width: 48px; height: 48px; display: grid; place-items: center; margin: 0 auto 13px; color: #fff; background: linear-gradient(145deg, var(--writer-accent), #334155); border: 1px solid rgba(255, 255, 255, .18); border-radius: 15px; box-shadow: 0 15px 35px var(--writer-accent-soft), inset 0 1px rgba(255, 255, 255, .25); font-size: 16px; font-weight: 800; }
  .flbps-writer-welcome h3 { margin: 0 0 7px; color: #f4f4f5; font-size: 13px; letter-spacing: -.02em; }
  .flbps-writer-welcome p { max-width: 285px; margin: 0 auto 16px; color: #85858f; font-size: 8.5px; line-height: 1.55; }
  .flbps-writer-starters { display: grid; grid-template-columns: 1fr 1fr; gap: 7px; }
  .flbps-writer-starters button { min-height: 38px; padding: 8px; color: #b9b9c2; background: rgba(34, 34, 40, .75); border: 1px solid var(--writer-border); border-radius: 9px; font-size: 8px; line-height: 1.25; cursor: pointer; }
  .flbps-writer-starters button:hover { color: #fff; background: var(--writer-accent-soft); border-color: color-mix(in srgb, var(--writer-accent), transparent 48%); transform: translateY(-1px); }
  .flbps-writer-message { max-width: none; padding: 0; background: transparent !important; border: 0 !important; border-radius: 0; animation: flbps-writer-rise .18s ease-out; }
  .flbps-writer-message.user { width: min(88%, 315px); align-self: flex-end; }
  .flbps-writer-message.assistant { width: 100%; align-self: stretch; }
  .flbps-writer-message-meta { min-height: 17px; display: flex; align-items: center; gap: 6px; margin: 0 3px 5px; color: #666671; font-size: 7px; }
  .flbps-writer-message-meta strong { color: #a7a7b0; font-size: 8px; font-weight: 650; }
  .flbps-writer-message.user .flbps-writer-message-meta { justify-content: flex-end; }
  .flbps-writer-message-meta span { min-width: 0; max-width: 150px; margin-left: auto; overflow: hidden; color: #5e5e68; text-overflow: ellipsis; white-space: nowrap; }
  .flbps-writer-message-body { color: #d8d8de; font-size: 9.5px; line-height: 1.58; white-space: normal; }
  .flbps-writer-message.user .flbps-writer-message-body { padding: 9px 11px; color: #eefcff; background: linear-gradient(145deg, rgba(8, 145, 178, .68), rgba(21, 94, 117, .78)); border: 1px solid rgba(103, 232, 249, .22); border-radius: 12px 12px 3px 12px; box-shadow: 0 9px 22px rgba(0, 0, 0, .16); white-space: pre-wrap; }
  .flbps-writer-message.assistant .flbps-writer-message-body { padding: 1px 3px; }
  .flbps-writer-image-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 5px; margin-top: 7px; white-space: normal; }
  .flbps-writer-image-grid[data-count="1"] { grid-template-columns: minmax(0, 1fr); }
  .flbps-writer-image-card { min-width: 0; margin: 0; overflow: hidden; background: rgba(8, 12, 18, .42); border: 1px solid rgba(255, 255, 255, .13); border-radius: 8px; }
  .flbps-writer-image-card > .flbps-writer-image-open { width: 100%; height: 76px; display: block; padding: 0; overflow: hidden; background: rgba(0, 0, 0, .25); border: 0; cursor: zoom-in; }
  .flbps-writer-image-grid[data-count="1"] .flbps-writer-image-card > .flbps-writer-image-open { height: 130px; }
  .flbps-writer-image-card img { width: 100%; height: 100%; display: block; object-fit: cover; transition: transform .18s ease; }
  .flbps-writer-image-card:hover img { transform: scale(1.025); }
  .flbps-writer-image-card figcaption { min-width: 0; height: 25px; display: flex; align-items: center; gap: 4px; padding: 4px 5px; color: #c4eaf2; background: rgba(8, 30, 39, .7); font-size: 6.5px; }
  .flbps-writer-image-card figcaption span { min-width: 0; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .flbps-writer-image-card figcaption button { width: 17px; height: 17px; flex: 0 0 17px; padding: 0; color: #fda4af; background: rgba(127, 29, 29, .22); border: 0; border-radius: 4px; font-size: 7px; cursor: pointer; }
  .flbps-writer-progress {
    margin: 3px 2px 10px;
    padding: 10px;
    background: linear-gradient(145deg, rgba(15, 37, 48, .88), rgba(24, 24, 29, .92));
    border: 1px solid rgba(56, 189, 248, .2);
    border-radius: 10px;
    box-shadow: inset 0 1px rgba(255, 255, 255, .035);
  }
  .flbps-writer-progress-head { display: flex; align-items: center; gap: 8px; margin-bottom: 7px; }
  .flbps-writer-progress-head strong { min-width: 0; flex: 1; overflow: hidden; color: #dff7ff; font-size: 8.5px; text-overflow: ellipsis; white-space: nowrap; }
  .flbps-writer-progress-head span { color: #7dd3fc; font-size: 7.5px; font-variant-numeric: tabular-nums; }
  .flbps-writer-progress-track { height: 5px; position: relative; overflow: hidden; background: rgba(255, 255, 255, .075); border-radius: 99px; }
  .flbps-writer-progress-track i { width: 0; height: 100%; display: block; background: linear-gradient(90deg, #0891b2, #22d3ee); border-radius: inherit; box-shadow: 0 0 10px rgba(34, 211, 238, .34); transition: width .2s ease; }
  .flbps-writer-progress-track.indeterminate i { animation: flbps-writer-progress 1.1s ease-in-out infinite; }
  .flbps-writer-progress small { display: block; margin-top: 7px; overflow: hidden; color: #7f929c; font-size: 7px; text-overflow: ellipsis; white-space: nowrap; }
  .flbps-writer-progress[data-state="drafted"], .flbps-writer-progress[data-state="applying"] { border-color: rgba(52, 211, 153, .2); }
  .flbps-writer-progress[data-state="drafted"] .flbps-writer-progress-track i,
  .flbps-writer-progress[data-state="applying"] .flbps-writer-progress-track i,
  .flbps-writer-progress[data-state="complete"] .flbps-writer-progress-track i { background: #34d399; box-shadow: 0 0 10px rgba(52, 211, 153, .3); }
  .flbps-writer-progress[data-state="error"] { border-color: rgba(251, 191, 36, .3); background: rgba(120, 53, 15, .16); }
  .flbps-writer-progress[data-state="error"] .flbps-writer-progress-track i { background: #f59e0b; }
  .flbps-writer-progress[data-state="stopped"] { opacity: .72; }
  .flbps-writer-message.interrupted { opacity: .68; }
  .flbps-writer-message.interrupted .flbps-writer-message-meta::after { content: "interrupted"; color: #fbbf24; }
  .flbps-writer-message.error .flbps-writer-message-meta::after { content: "failed in background"; color: #fb7185; }
  .flbps-writer-message.error .flbps-writer-message-body { padding: 8px; color: #fecaca; background: rgba(127, 29, 29, .18); border: 1px solid rgba(251, 113, 133, .18); border-radius: 8px; }
  .flbps-writer-message.streaming .flbps-writer-message-body::after { content: ""; width: 5px; height: 12px; display: inline-block; margin-left: 3px; vertical-align: -2px; background: var(--writer-accent); border-radius: 1px; animation: flbps-writer-cursor .85s steps(1) infinite; }
  .flbps-writer-message-actions { min-height: 20px; display: flex; gap: 2px; margin: 5px 0 0; opacity: .25; transition: opacity .12s ease; }
  .flbps-writer-message.user .flbps-writer-message-actions { justify-content: flex-end; }
  .flbps-writer-message:hover .flbps-writer-message-actions, .flbps-writer-message-actions:focus-within { opacity: 1; }
  .flbps-writer-message-actions button { padding: 3px 5px; color: #85858f; background: transparent; border: 0; border-radius: 4px; font-size: 7px; cursor: pointer; }
  .flbps-writer-message-actions button:hover { color: #e4e4e7; background: rgba(255, 255, 255, .05); }
  .flbps-writer-message-actions span { padding: 3px; color: #61616b; font-size: 7px; }
  .flbps-writer-message-edit textarea { width: 100%; min-height: 88px; padding: 8px; resize: vertical; color: #f4f4f5; background: #18181d; border: 1px solid var(--writer-accent); border-radius: 8px; font: inherit; line-height: 1.5; }
  .flbps-writer-message-edit > div { display: flex; justify-content: flex-end; gap: 5px; margin-top: 6px; }
  .flbps-writer-message-edit button { padding: 5px 7px; background: #26262c; border: 1px solid var(--writer-border); border-radius: 6px; font-size: 7px; cursor: pointer; }
  .flbps-writer-activity { margin: 9px 2px 2px; overflow: hidden; background: rgba(24, 24, 29, .72); border: 1px solid var(--writer-border); border-radius: 9px; }
  .flbps-writer-activity summary { min-height: 31px; display: flex; align-items: center; gap: 7px; padding: 7px 9px; color: #9999a3; list-style: none; cursor: pointer; user-select: none; }
  .flbps-writer-activity summary::-webkit-details-marker { display: none; }
  .flbps-writer-activity summary > i { width: 7px; height: 7px; flex: 0 0 7px; background: #34d399; border: 2px solid rgba(52, 211, 153, .2); border-radius: 50%; }
  .flbps-writer-activity.running summary > i { background: transparent; border-color: var(--writer-accent) transparent var(--writer-accent) var(--writer-accent); animation: flbps-writer-spin .8s linear infinite; }
  .flbps-writer-activity-label { flex: 1; font-size: 7.5px; font-weight: 600; }
  .flbps-writer-activity-count { color: #5f5f69; font-size: 7px; }
  .flbps-writer-activity-list { padding: 0 8px 7px 21px; border-top: 1px solid rgba(255, 255, 255, .045); }
  .flbps-writer-activity-step { position: relative; display: flex; align-items: center; gap: 7px; padding: 7px 0 0; color: #7f7f89; font-size: 7.5px; }
  .flbps-writer-activity-step i { width: 5px; height: 5px; flex: 0 0 5px; background: #34d399; border-radius: 50%; }
  .flbps-writer-activity-step.running i { background: var(--writer-accent); box-shadow: 0 0 8px var(--writer-accent); animation: flbps-writer-pulse 1s ease-in-out infinite; }
  .flbps-writer-jump { position: absolute; z-index: 5; right: 14px; bottom: 150px; padding: 6px 9px; color: #d4d4d8; background: rgba(36, 36, 42, .95); border: 1px solid rgba(255, 255, 255, .12); border-radius: 99px; box-shadow: 0 7px 20px rgba(0, 0, 0, .32); font-size: 7px; cursor: pointer; animation: flbps-writer-rise .15s ease-out; }
  .flbps-writer-jump span { margin-left: 4px; color: var(--writer-accent); }
  .flbps-writer-error { flex: 0 0 auto; display: flex; align-items: center; gap: 7px; padding: 8px 10px; color: #fecaca; background: rgba(127, 29, 29, .28); border-top: 1px solid rgba(251, 113, 133, .22); font-size: 7.5px; }
  .flbps-writer-error > span { min-width: 0; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .flbps-writer-error button { padding: 3px 5px; color: #ffe4e6; background: rgba(255, 255, 255, .08); border: 0; border-radius: 4px; font-size: 7px; cursor: pointer; }
  .flbps-writer-run-status { flex: 0 0 auto; display: flex; align-items: center; gap: 7px; padding: 7px 11px; color: #9b9ba5; background: rgba(21, 21, 25, .96); border-top: 1px solid var(--writer-border); font-size: 7.5px; }
  .flbps-writer-run-status > span:nth-child(2) { min-width: 0; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .flbps-writer-run-status button { padding: 4px 7px; color: #fca5a5; background: rgba(127, 29, 29, .18); border: 1px solid rgba(248, 113, 113, .18); border-radius: 5px; font-size: 7px; cursor: pointer; }
  .flbps-writer-spinner { width: 10px; height: 10px; flex: 0 0 10px; border: 2px solid rgba(255, 255, 255, .12); border-top-color: var(--writer-accent); border-radius: 50%; animation: flbps-writer-spin .75s linear infinite; }
  .flbps-writer-composer-card { flex: 0 0 auto; margin: 0 10px 10px; overflow: hidden; background: rgba(32, 32, 38, .94); border: 1px solid rgba(255, 255, 255, .11); border-radius: 12px; box-shadow: 0 12px 35px rgba(0, 0, 0, .25); transition: border-color .14s ease, box-shadow .14s ease; }
  .flbps-writer-composer-card:focus-within { border-color: color-mix(in srgb, var(--writer-accent), transparent 35%); box-shadow: 0 12px 35px rgba(0, 0, 0, .25), 0 0 0 2px var(--writer-accent-soft); }
  .flbps-writer-composer-card.drag-active { border-color: var(--writer-accent); box-shadow: 0 0 0 2px var(--writer-accent-soft), 0 12px 35px rgba(0, 0, 0, .25); }
  .flbps-writer-composer-card.uploading { opacity: .72; }
  .flbps-writer-composer-options { padding: 7px 8px 0; }
  .flbps-writer-composer-options label { min-width: 0; display: flex; align-items: center; gap: 4px; color: #6f6f79; font-size: 7px; }
  .flbps-writer-composer-options label:first-child { flex: 1; }
  .flbps-writer-composer-options select { width: auto; min-width: 0; padding: 3px 18px 3px 5px; color: #9c9ca6; background: rgba(255, 255, 255, .035); border: 1px solid rgba(255, 255, 255, .075); border-radius: 5px; font-size: 7px; }
  .flbps-writer-attachments { max-height: 175px; padding: 7px 8px 0; overflow: auto; }
  .flbps-writer-attachments .flbps-writer-image-grid { margin: 0; }
  .flbps-writer-attachments .flbps-writer-image-card > .flbps-writer-image-open { height: 62px; }
  .flbps-writer-chat .flbps-writer-composer { width: 100%; height: 66px; min-height: 52px; padding: 9px 10px 4px; resize: none; color: #f1f1f3; background: transparent; border: 0; outline: 0; font-size: 9.5px; line-height: 1.45; }
  .flbps-writer-composer::placeholder { color: #666670; }
  .flbps-writer-composer-footer { display: flex; align-items: center; gap: 7px; padding: 4px 7px 7px 10px; }
  .flbps-writer-composer-footer > span { min-width: 0; flex: 1; color: #575761; font-size: 6.5px; }
  .flbps-writer-attach { width: 27px; height: 27px; flex: 0 0 27px; padding: 0; color: #8b8b95; background: rgba(255, 255, 255, .045); border: 1px solid rgba(255, 255, 255, .08); border-radius: 7px; font-size: 6.5px; cursor: pointer; }
  .flbps-writer-attach:hover { color: #cffafe; background: var(--writer-accent-soft); border-color: color-mix(in srgb, var(--writer-accent), transparent 55%); }
  .flbps-writer-send { width: 28px; height: 28px; display: grid; place-items: center; color: #071218 !important; background: var(--writer-accent); border: 0; border-radius: 8px; box-shadow: 0 5px 14px var(--writer-accent-soft); font-size: 7px; font-weight: 800; cursor: pointer; transition: transform .12s ease, opacity .12s ease; }
  .flbps-writer-send:hover:not(:disabled) { transform: translateY(-1px) scale(1.03); }
  .flbps-writer-send:disabled { opacity: .25; cursor: default; }
  .flbps-writer-sheet { background: linear-gradient(180deg, rgba(22, 22, 27, .97), #121215); animation: flbps-writer-sheet-in .18s ease-out; }
  .flbps-writer-sheet-header { min-height: 57px; padding: 9px 11px; background: rgba(27, 27, 32, .82); border-color: var(--writer-border); backdrop-filter: blur(12px); }
  .flbps-writer-sheet-header > div { display: flex; flex-direction: column; gap: 2px; }
  .flbps-writer-sheet-header strong { color: #f1f1f3; font-size: 11px; }
  .flbps-writer-sheet-header small { color: #696973; font-size: 7px; }
  .flbps-writer-sheet-body { padding: 11px; }
  .flbps-writer-settings-card { margin: 0 0 9px; overflow: hidden; background: rgba(30, 30, 35, .8); border: 1px solid var(--writer-border); border-radius: 10px; }
  .flbps-writer-settings-card > summary { min-height: 39px; display: flex; align-items: center; gap: 8px; padding: 9px 10px; color: #d7d7dc; list-style: none; cursor: pointer; }
  .flbps-writer-settings-card > summary::-webkit-details-marker { display: none; }
  .flbps-writer-settings-card > summary span { flex: 1; font-size: 9px; font-weight: 700; }
  .flbps-writer-settings-card > summary em { padding: 3px 6px; color: #8d8d97; background: rgba(255, 255, 255, .045); border-radius: 99px; font-size: 6.5px; font-style: normal; font-weight: 500; }
  .flbps-writer-settings-card > summary em[data-state="ready"] { color: #a7f3d0; background: rgba(16, 185, 129, .1); }
  .flbps-writer-settings-card > summary em[data-state="error"] { color: #fda4af; background: rgba(244, 63, 94, .1); }
  .flbps-writer-settings-card > div { padding: 10px; border-top: 1px solid rgba(255, 255, 255, .055); }
  .flbps-writer-settings-card label { display: flex; flex-direction: column; gap: 4px; margin-bottom: 9px; color: #82828c; font-size: 7.5px; }
  .flbps-writer-settings-card input, .flbps-writer-settings-card select, .flbps-writer-settings-card textarea,
  .flbps-writer-history-tools input, .flbps-writer-history-rename {
    width: 100%;
    padding: 7px 8px;
    color: #efeff1;
    background: #17171b;
    border: 1px solid rgba(255, 255, 255, .1);
    border-radius: 7px;
    outline: 0;
    font-size: 8.5px;
  }
  .flbps-writer-settings-card textarea { min-height: 105px; resize: vertical; line-height: 1.5; }
  .flbps-writer-inline { display: flex; gap: 5px; }
  .flbps-writer-inline input { min-width: 0; flex: 1; }
  .flbps-writer-inline button, .flbps-writer-subscription button { padding: 0 8px; color: #b7b7c0; background: #29292f; border: 1px solid var(--writer-border); border-radius: 6px; font-size: 7px; cursor: pointer; }
  .flbps-writer-setting-row { display: grid; grid-template-columns: 1fr 1fr; gap: 7px; }
  .flbps-writer-subscription { padding: 8px; background: rgba(255, 255, 255, .03); border: 1px solid var(--writer-border); border-radius: 7px; }
  .flbps-writer-subscription p { color: #92929c; font-size: 7.5px; }
  .flbps-writer-settings-save { width: 100%; padding: 8px; color: #071218 !important; background: var(--writer-accent); border: 0; border-radius: 7px; font-size: 8px; font-weight: 750; cursor: pointer; }
  .flbps-writer-scope-note { margin: 2px 0 0; padding: 8px; color: #70707a; background: rgba(255, 255, 255, .025); border-left: 2px solid var(--writer-accent); border-radius: 3px; font-size: 7px; line-height: 1.5; }
  .flbps-writer-history-tools { flex: 0 0 auto; padding: 10px; border-bottom: 1px solid var(--writer-border); }
  .flbps-writer-history-tabs { display: grid; grid-template-columns: 1fr 1fr; gap: 3px; margin-bottom: 8px; padding: 3px; background: #111114; border: 1px solid rgba(255, 255, 255, .07); border-radius: 8px; }
  .flbps-writer-history-tabs button { padding: 6px; color: #777781; background: transparent; border: 0; border-radius: 5px; font-size: 7.5px; cursor: pointer; }
  .flbps-writer-history-tabs button.active { color: #e4e4e7; background: #29292f; box-shadow: 0 2px 7px rgba(0, 0, 0, .22); }
  .flbps-writer-history { padding: 9px; }
  .flbps-writer-history-row { min-height: 52px; display: flex; align-items: center; gap: 5px; margin-bottom: 6px; padding: 5px; background: rgba(29, 29, 34, .82); border: 1px solid var(--writer-border); border-radius: 9px; transition: border-color .12s ease, background .12s ease; }
  .flbps-writer-history-row:hover { background: #222228; border-color: rgba(255, 255, 255, .14); }
  .flbps-writer-history-row.active { border-color: color-mix(in srgb, var(--writer-accent), transparent 45%); box-shadow: inset 2px 0 var(--writer-accent); }
  .flbps-writer-history-select { min-width: 0; flex: 1; display: flex; flex-direction: column; gap: 4px; padding: 6px; background: transparent; border: 0; text-align: left; cursor: pointer; }
  .flbps-writer-history-select strong { overflow: hidden; color: #d8d8de; font-size: 8.5px; font-weight: 650; text-overflow: ellipsis; white-space: nowrap; }
  .flbps-writer-history-select small { overflow: hidden; color: #666670; font-size: 6.5px; text-overflow: ellipsis; white-space: nowrap; }
  .flbps-writer-history-actions { display: flex; gap: 3px; opacity: .28; transition: opacity .12s ease; }
  .flbps-writer-history-row:hover .flbps-writer-history-actions, .flbps-writer-history-actions:focus-within { opacity: 1; }
  .flbps-writer-history-actions .flbps-writer-icon-button { min-width: 27px; height: 27px; padding: 0 5px; border: 0; font-size: 6px; }
  .flbps-writer-history-rename { min-width: 0; flex: 1; }
  .flbps-writer-history-empty { margin: 35px 8px; color: #6f6f79; font-size: 8px; text-align: center; }
  .flbps-writer-toast { max-width: 310px; position: absolute; z-index: 30; right: 12px; bottom: 12px; padding: 9px 11px; color: #d4d4d8; background: rgba(35, 35, 41, .97); border: 1px solid rgba(255, 255, 255, .12); border-radius: 8px; box-shadow: 0 15px 35px rgba(0, 0, 0, .42); font-size: 8px; animation: flbps-writer-toast-in .18s ease-out; }
  .flbps-writer-toast[data-state="success"] { border-color: rgba(52, 211, 153, .28); }
  .flbps-writer-toast[data-state="error"] { border-color: rgba(251, 113, 133, .32); }
  .flbps-writer-confirm { position: absolute; z-index: 40; inset: 0; display: grid; place-items: center; padding: 20px; background: rgba(7, 7, 9, .72); backdrop-filter: blur(5px); animation: flbps-fade-in .14s ease-out; }
  .flbps-writer-confirm > div { width: min(100%, 285px); padding: 16px; background: #232329; border: 1px solid rgba(255, 255, 255, .12); border-radius: 12px; box-shadow: 0 24px 60px rgba(0, 0, 0, .52); }
  .flbps-writer-confirm strong { color: #f4f4f5; font-size: 10px; }
  .flbps-writer-confirm p { margin: 7px 0 14px; color: #898993; font-size: 8px; line-height: 1.45; }
  .flbps-writer-confirm footer { display: flex; justify-content: flex-end; gap: 6px; }
  .flbps-writer-confirm button { padding: 6px 9px; color: #bdbdc5; background: #2d2d34; border: 1px solid var(--writer-border); border-radius: 6px; font-size: 7px; cursor: pointer; }
  .flbps-writer-confirm button.danger { color: #fff1f2; background: #9f1239; border-color: #be123c; }
  .flbps-writer-image-preview { position: absolute; z-index: 35; inset: 0; display: grid; place-items: center; padding: 18px; background: rgba(7, 7, 9, .8); backdrop-filter: blur(5px); animation: flbps-fade-in .14s ease-out; }
  .flbps-writer-image-preview > div { max-width: 100%; max-height: 100%; position: relative; display: flex; flex-direction: column; gap: 6px; padding: 7px; background: #202026; border: 1px solid rgba(255, 255, 255, .13); border-radius: 11px; box-shadow: 0 24px 60px rgba(0, 0, 0, .55); }
  .flbps-writer-image-preview img { max-width: 340px; max-height: calc(100vh - 170px); display: block; object-fit: contain; background: #09090b; border-radius: 7px; }
  .flbps-writer-image-preview span { max-width: 320px; overflow: hidden; color: #a9a9b2; font-size: 7px; text-overflow: ellipsis; white-space: nowrap; }
  .flbps-writer-image-preview button { width: 22px; height: 22px; position: absolute; z-index: 1; top: 10px; right: 10px; padding: 0; color: #fafafa; background: rgba(9, 9, 11, .76); border: 1px solid rgba(255, 255, 255, .18); border-radius: 6px; font-size: 8px; cursor: pointer; }
  .flbps-writer-markdown { line-height: 1.58; }
  .flbps-writer-markdown p { margin: 0 0 8px; }
  .flbps-writer-markdown h3, .flbps-writer-markdown h4, .flbps-writer-markdown h5 { margin: 11px 0 5px; font-size: 10px; }
  .flbps-writer-markdown ul { margin: 5px 0 8px; padding-left: 18px; }
  .flbps-writer-markdown pre { padding: 8px; background: #0c0c0f; border: 1px solid rgba(255, 255, 255, .06); border-radius: 7px; }
  @keyframes flbps-writer-spin { to { transform: rotate(360deg); } }
  @keyframes flbps-writer-pulse { 0%, 100% { opacity: .45; } 50% { opacity: 1; } }
  @keyframes flbps-writer-cursor { 0%, 48% { opacity: 1; } 49%, 100% { opacity: 0; } }
  @keyframes flbps-writer-rise { from { opacity: 0; transform: translateY(5px); } to { opacity: 1; transform: translateY(0); } }
  @keyframes flbps-writer-pop { from { opacity: 0; transform: translateY(-4px) scale(.98); } to { opacity: 1; transform: translateY(0) scale(1); } }
  @keyframes flbps-writer-sheet-in { from { opacity: 0; transform: translateX(8px); } to { opacity: 1; transform: translateX(0); } }
  @keyframes flbps-writer-toast-in { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }
  @keyframes flbps-writer-progress { from { transform: translateX(-115%); } to { transform: translateX(360%); } }
  @media (prefers-reduced-motion: reduce) {
    .flbps-writer *, .flbps-writer *::before, .flbps-writer *::after { scroll-behavior: auto !important; animation-duration: .001ms !important; animation-iteration-count: 1 !important; transition-duration: .001ms !important; }
    .flbps-writer-toggle-indicator { animation: none !important; }
    .flbps-writer-progress-track.indeterminate i { animation: none !important; transform: none !important; }
  }
  .flbps-sidebar-toggle {
    width: 28px;
    height: 52px;
    min-width: 0;
    position: absolute;
    z-index: 4;
    top: 50%;
    right: -14px;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0 1px 2px 0;
    color: #a1a1aa;
    background: #202027;
    border: 1px solid #3f3f46;
    border-radius: 0 8px 8px 0;
    box-shadow: 4px 0 12px rgba(0, 0, 0, .28);
    font-size: 20px;
    line-height: 1;
    transform: translateY(-50%);
    cursor: pointer;
  }
  .flbps-sidebar-toggle:hover { color: #f4f4f5; background: #2a2a31; border-color: #52525b; }
  .flbps-sidebar-toggle:focus-visible { outline: 2px solid #22d3ee; outline-offset: 2px; }
  .flbps-modal-shell.library-collapsed .flbps-sidebar-toggle {
    color: #cffafe;
    background: #164e63;
    border-color: #0e7490;
  }
  .flbps-modal-close { min-width: 66px; }
  @keyframes flbps-fade-in { from { opacity: 0; } to { opacity: 1; } }
  @keyframes flbps-modal-in {
    from { opacity: 0; transform: scale(.975) translateY(-8px); }
    to { opacity: 1; transform: scale(1) translateY(0); }
  }
  @media (max-width: 980px) {
    .flbps-modal-overlay { padding: 0; }
    .flbps-modal-shell { width: 100vw; height: 100vh; min-width: 0; min-height: 0; border-radius: 0; }
    .flbps-library { width: 250px; flex-basis: 250px; }
    .flbps-status { display: none; }
    .flbps-toolbar-divider { display: none; }
    .flbps-writer-toggle { max-width: 185px; }
    .flbps-volume input[type="range"] { width: 56px; }
    .flbps-volume-value { display: none; }
    .flbps-modal-shell.writer-open .flbps-writer-host { width: 310px; flex-basis: 310px; }
    .flbps-writer { width: 310px; }
  }
  @media (max-width: 1250px) and (min-width: 981px) {
    .flbps-status { max-width: 220px; }
    .flbps-source-label { max-width: 130px; }
  }
  @media (max-width: 1180px) {
    .flbps-inspector-tabs { display: flex; gap: 6px; }
    .flbps-inspector { display: block; }
    .flbps-inspector[data-tab="prompt"] .flbps-envelope-panel { display: none; }
    .flbps-inspector[data-tab="envelopes"] .flbps-clip-inspector { display: none; }
    .flbps-inspector[data-tab="envelopes"] .flbps-song-inspector { display: none; }
    .flbps-inspector[data-tab="envelopes"] .flbps-lyrics-inspector { display: none; }
    .flbps-clip-inspector, .flbps-song-inspector, .flbps-lyrics-inspector, .flbps-envelope-panel { height: 100%; }
  }
`;

export function injectBeatPromptSequencerStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = STYLES;
  document.head.appendChild(style);
}
