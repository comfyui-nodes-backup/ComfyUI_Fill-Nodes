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
    height: clamp(300px, 45vh, 420px);
    flex: 0 1 420px;
    min-height: 280px;
    overflow: hidden;
    background: #101013;
  }
  .flbps-canvas { width: 100%; height: 100%; display: block; touch-action: none; }
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
  .flbps-clip-inspector, .flbps-envelope-panel {
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
  .flbps-clip-inspector.disabled { opacity: 0.45; pointer-events: none; }
  .flbps-inspector-grid {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 6px;
    margin-bottom: 7px;
  }
  .flbps-field { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
  .flbps-field label { color: #8b8b95; font-size: 8px; text-transform: uppercase; letter-spacing: .04em; }
  .flbps-field input { width: 100%; height: 24px; padding: 3px 5px; font-size: 10px; }
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
    .flbps-volume input[type="range"] { width: 56px; }
    .flbps-volume-value { display: none; }
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
    .flbps-clip-inspector, .flbps-envelope-panel { height: 100%; }
  }
`;

export function injectBeatPromptSequencerStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = STYLES;
  document.head.appendChild(style);
}
