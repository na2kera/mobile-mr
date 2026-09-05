// 俯瞰画面（PC）の「コートの寸法」「追加マーカーの配置」の入力欄。08 の overview.ts に書いたものを 10（ゴルフ）で
// 2 回目に必要になったので抽出した（08 の overview.ts は過去のデモとして手を付けず、複製のまま）。
// 役割: 入力欄の生成・サーバーの値との同期・検証・「反映」ボタンの活性。送信は呼ぶ側（onApply）が行う。
// DOM の構造（id / class）は 08 と同じにして、見た目の CSS を流用できるようにしている
import { FIELD_SIZE_KEYS, FIELD_SIZE_LIMITS, validateFieldSize } from "./splatoon-sim";
import type { FieldSize } from "./splatoon-sim";
import { FACE_LABELS, MARKER_FACES, MAX_EXTRA_MARKERS, SUGGESTED_MARKERS, suggestedMarkerPos, validateMarkerLayout } from "./marker-layout";
import type { MarkerFace, MarkerPlacement } from "./marker-layout";

export type FieldSetupOptions = {
  /** 原点マーカーの ID（追加マーカーの既定 ID が重ならないように） */
  originMarkerId: number;
  sizeInputs: Record<keyof FieldSize, HTMLInputElement>;
  applySizeButton: HTMLButtonElement;
  sizeHint: HTMLElement;
  markerRowsEl: HTMLElement;
  applyMarkersButton: HTMLButtonElement;
  markersHint: HTMLElement;
  /** 「反映」で寸法を送る。送れたら true（pending にする） */
  onApplySize: (size: FieldSize) => boolean;
  onApplyMarkers: (markers: MarkerPlacement[]) => boolean;
  /** 入力が変わった（呼ぶ側がパネルを描き直す契機） */
  onInput: () => void;
  /** 寸法を変えると何が起きるかの文言（08: 塗りが消える / 10: 最初からになる） */
  sizeChangeNote: string;
  markersChangeNote: string;
};

type MarkerRow = { root: HTMLDivElement; use: HTMLInputElement; face: HTMLSelectElement; id: HTMLInputElement; pos: [HTMLInputElement, HTMLInputElement, HTMLInputElement] };

export type FieldSetupPanel = {
  /** サーバーの config が届いたら呼ぶ（入力欄をサーバーの値に揃える） */
  syncSize(cfg: FieldSize): void;
  syncMarkers(cfg: FieldSize & { markers: MarkerPlacement[] }): void;
  /** 送信中（pending）と編集可否を渡して描き直す */
  render(state: { editable: boolean; sizePending: boolean; markersPending: boolean; joined: boolean; current: FieldSize & { markers: MarkerPlacement[] }; extraSizeInfo?: string }): { sizeInvalid: string | null; markersInvalid: string | null };
  readSize(): FieldSize;
  readMarkers(): MarkerPlacement[];
};

export function createFieldSetupPanel(opts: FieldSetupOptions): FieldSetupPanel {
  const { sizeInputs, markerRowsEl } = opts;
  for (const key of FIELD_SIZE_KEYS) {
    sizeInputs[key].min = String(FIELD_SIZE_LIMITS[key].min);
    sizeInputs[key].max = String(FIELD_SIZE_LIMITS[key].max);
    sizeInputs[key].addEventListener("input", () => opts.onInput());
  }
  /** いまの寸法（床のマーカーの Y と既定の位置に使う） */
  let current: FieldSize & { markers: MarkerPlacement[] } = { wallW: 3, wallH: 2.4, floorDepth: 2.5, floorDrop: 1.2, markers: [] };

  // 行の既定値: おすすめの 5 枚 + 予備。既定の ID は原点と重ならない番号へずらす
  const ROW_DEFAULTS: readonly { face: MarkerFace; id: number }[] = (() => {
    const used = new Set<number>([opts.originMarkerId]);
    const alloc = (want: number) => {
      let id = want;
      while (used.has(id)) id++;
      used.add(id);
      return id;
    };
    return [
      ...SUGGESTED_MARKERS.map((s) => ({ face: s.face, id: alloc(s.id) })),
      ...Array.from({ length: Math.max(0, MAX_EXTRA_MARKERS - SUGGESTED_MARKERS.length) }, (_, i) => ({ face: "wall" as MarkerFace, id: alloc(SUGGESTED_MARKERS.length + 1 + i) })),
    ];
  })();
  const rows: MarkerRow[] = ROW_DEFAULTS.map((suggested) => {
    const root = document.createElement("div");
    root.className = "row off";
    const use = document.createElement("input");
    use.type = "checkbox";
    use.title = "このマーカーを使う";
    const face = document.createElement("select");
    for (const f of MARKER_FACES) {
      const opt = document.createElement("option");
      opt.value = f;
      opt.textContent = FACE_LABELS[f];
      face.append(opt);
    }
    face.value = suggested.face;
    const id = document.createElement("input");
    id.type = "number";
    id.min = "0";
    id.step = "1";
    id.inputMode = "numeric";
    id.value = String(suggested.id);
    const pos = [0, 1, 2].map(() => {
      const i = document.createElement("input");
      i.type = "number";
      i.step = "0.05";
      i.inputMode = "decimal";
      return i;
    }) as MarkerRow["pos"];
    root.append(use, face, id, ...pos);
    markerRowsEl.append(root);
    const row: MarkerRow = { root, use, face, id, pos };
    face.addEventListener("change", () => {
      setRowPos(row, suggestedMarkerPos(face.value as MarkerFace, current));
      opts.onInput();
    });
    use.addEventListener("change", () => opts.onInput());
    for (const el of [id, ...pos]) el.addEventListener("input", () => opts.onInput());
    setRowPos(row, suggestedMarkerPos(suggested.face, current));
    return row;
  });
  function setRowPos(row: MarkerRow, p: readonly number[]) {
    for (let k = 0; k < 3; k++) row.pos[k].value = String(p[k]);
  }

  function readSize(): FieldSize {
    return {
      wallW: Number(sizeInputs.wallW.value),
      wallH: Number(sizeInputs.wallH.value),
      floorDepth: Number(sizeInputs.floorDepth.value),
      floorDrop: Number(sizeInputs.floorDrop.value),
    };
  }
  function sizeChanged(): boolean {
    const v = readSize();
    return FIELD_SIZE_KEYS.some((k) => v[k] !== current[k]);
  }
  /** 空欄・数値でない入力は NaN のまま渡して validateMarkerLayout に弾かせる（Number("") は 0 になり原点の位置として配られてしまう） */
  function readMarkers(): MarkerPlacement[] {
    const out: MarkerPlacement[] = [];
    for (const row of rows) {
      if (!row.use.checked) continue;
      const face = row.face.value as MarkerFace;
      const y = face === "floor" ? -current.floorDrop : row.pos[1].valueAsNumber;
      out.push({ id: row.id.valueAsNumber, face, pos: [row.pos[0].valueAsNumber, y, row.pos[2].valueAsNumber] });
    }
    return out;
  }
  function markersChanged(): boolean {
    const key = (ms: readonly MarkerPlacement[]) => JSON.stringify([...ms].sort((a, b) => a.id - b.id));
    return key(readMarkers()) !== key(current.markers);
  }

  opts.applySizeButton.addEventListener("click", () => {
    const size = readSize();
    const invalid = validateFieldSize(size);
    if (invalid) return;
    opts.onApplySize(size);
  });
  opts.applyMarkersButton.addEventListener("click", () => {
    const markers = readMarkers();
    if (validateMarkerLayout(markers, opts.originMarkerId, current.floorDrop)) return;
    opts.onApplyMarkers(markers);
  });

  return {
    syncSize(cfg) {
      current = { ...current, wallW: cfg.wallW, wallH: cfg.wallH, floorDepth: cfg.floorDepth, floorDrop: cfg.floorDrop };
      for (const key of FIELD_SIZE_KEYS) sizeInputs[key].value = String(cfg[key]);
    },
    syncMarkers(cfg) {
      current = { ...cfg, markers: cfg.markers.map((m) => ({ ...m, pos: [m.pos[0], m.pos[1], m.pos[2]] })) };
      const assigned = new Map<MarkerRow, MarkerPlacement>();
      const pending: MarkerPlacement[] = [];
      for (const m of current.markers) {
        const row = rows.find((r) => r.id.valueAsNumber === m.id && !assigned.has(r));
        if (row) assigned.set(row, m);
        else pending.push(m);
      }
      for (const m of pending) {
        const row = rows.find((r) => !assigned.has(r));
        if (row) assigned.set(row, m);
        else console.warn(`[field-setup] 追加マーカー ${m.id}:${m.face} は行が足りず表示できません（反映すると消えます）`);
      }
      rows.forEach((row, i) => {
        const m = assigned.get(row);
        if (m) {
          row.use.checked = true;
          row.face.value = m.face;
          row.id.value = String(m.id);
          setRowPos(row, m.pos);
        } else {
          const suggested = ROW_DEFAULTS[i];
          row.use.checked = false;
          row.face.value = suggested.face;
          row.id.value = String(suggested.id);
          setRowPos(row, suggestedMarkerPos(suggested.face, current));
        }
      });
    },
    render(state) {
      current = { ...state.current, markers: state.current.markers };
      const sizeEditable = state.joined && state.editable && !state.sizePending;
      const sizeInvalid = validateFieldSize(readSize());
      const canApplySize = sizeEditable && sizeChanged() && sizeInvalid === null;
      const sizeHintText = !state.joined
        ? ""
        : sizeInvalid
          ? sizeInvalid
          : sizeChanged()
            ? opts.sizeChangeNote
            : `いま: 幅 ${current.wallW}m × 高さ ${current.wallH}m × 奥行き ${current.floorDepth}m、マーカーの高さ ${current.floorDrop}m${state.extraSizeInfo ?? ""}`;
      const markersEditable = state.joined && state.editable && !state.markersPending;
      const markersInvalid = validateMarkerLayout(readMarkers(), opts.originMarkerId, current.floorDrop);
      const canApplyMarkers = markersEditable && markersChanged() && markersInvalid === null;
      const markersHintText = !state.joined
        ? ""
        : markersInvalid
          ? markersInvalid
          : markersChanged()
            ? opts.markersChangeNote
            : `いま: ${current.markers.length === 0 ? "正面のマーカーだけ" : current.markers.map((m) => `${FACE_LABELS[m.face]} ${m.id} (${m.pos.join(", ")})`).join(" / ")}`;
      for (const key of FIELD_SIZE_KEYS) sizeInputs[key].disabled = !sizeEditable;
      opts.applySizeButton.disabled = !canApplySize;
      opts.applySizeButton.textContent = state.sizePending ? "送信中…" : "反映";
      opts.sizeHint.textContent = sizeHintText;
      for (const row of rows) {
        row.use.disabled = !markersEditable;
        row.root.classList.toggle("off", !row.use.checked);
        const isFloor = row.face.value === "floor";
        if (isFloor) row.pos[1].value = String(-current.floorDrop);
        row.face.disabled = !markersEditable;
        row.id.disabled = !markersEditable;
        row.pos[0].disabled = !markersEditable;
        row.pos[1].disabled = !markersEditable || isFloor;
        row.pos[1].title = isFloor ? "床のマーカーの高さは「マーカーの高さ」から自動" : "";
        row.pos[2].disabled = !markersEditable;
      }
      opts.applyMarkersButton.disabled = !canApplyMarkers;
      opts.applyMarkersButton.textContent = state.markersPending ? "送信中…" : "反映";
      opts.markersHint.textContent = markersHintText;
      return { sizeInvalid, markersInvalid };
    },
    readSize,
    readMarkers,
  };
}
