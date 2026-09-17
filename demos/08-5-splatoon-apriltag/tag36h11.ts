// AprilTag の tag36h11 ファミリの絵柄（印刷ページ markers.html とフェイクカメラ fake-apriltags.ts で使う）。
// 検出は WASM（apriltag-detector.ts）が持つ辞書で行うので、ここは「描く側」だけ。
// 符号表と bit の座標は apriltag の tag36h11.c（AprilRobotics/apriltag、BSD-2-Clause）から写した:
//   - codedata[587] のうち先頭 250 個（08 の配置の ID 上限 MAX_MARKER_ID = 249 と揃える。サーバーの検証もこの範囲）
//   - bit i は 36 bit 符号の上位から i 番目（apriltag.c の quad_decode: rcode = (rcode << 1) | v）で、1 = 白
//   - bit i の位置は (bit_x[i], bit_y[i])。黒枠の外側の左上を (0,0) とする 8×8 のセル座標（x 右・y 下）で 1〜6 が中身
//   - 幾何は width_at_border = 8（黒い正方形 = 8 セル）、total_width = 10（外側に白い余白 1 セル）。
//     ARUCO_MIP_36h12（08）と同じ「余白 1 + 黒枠 1 + 中身 6 + 黒枠 1 + 余白 1」なので、fake-markers.ts の投影（10 セル格子）がそのまま使える
// ID 0 / 1 / 5 が公式の画像（AprilRobotics/apriltag-imgs の tag36h11/tag36_11_0000N.png、10×10 px）とセル単位で一致することを確認済み
// （scripts/test-08-5-apriltag.mjs に期待パターンとして残してある）。three.js に依存させない（Node のテストから import するため）

/** tag36h11 の符号（36 bit）。添字 = ID */
const CODES: readonly string[] = [
  "0xd7e00984b", "0xdda664ca7", "0xdc4a1c821", "0xe17b470e9", "0xef91d01b1", "0xf429cdd73", "0x5da29225", "0x1106cba43", "0x223bed79d", "0x21f51213c",
  "0x33eb19ca6", "0x3f76eb0f8", "0x469a97414", "0x45dcfe0b0", "0x4a6465f72", "0x51801db96", "0x5eb946b4e", "0x68a7cc2ec", "0x6f0ba2652", "0x78765559d",
  "0x87b83d129", "0x86cc4a5c5", "0x8b64df90f", "0x9c577b611", "0xa3810f2f5", "0xaf4d75b83", "0xb59a03fef", "0xbb1096f85", "0xd1b92fc76", "0xd0dd509d2",
  "0xe2cfda160", "0x2ff497c63", "0x47240671b", "0x5047a2e55", "0x635ca87c7", "0x691254166", "0x68f43d94a", "0x6ef24bdb6", "0x8cdd8f886", "0x9de96b718",
  "0xaff6e5a8a", "0xbae46f029", "0xd225b6d59", "0xdf8ba8c01", "0xe3744a22f", "0xfbb59375d", "0x18a916828", "0x22f29c1ba", "0x286887d58", "0x41392322e",
  "0x75d18ecd1", "0x87c302743", "0x8c6317ba9", "0x9e40f36d7", "0xc0e5a806a", "0xcc78cb87c", "0x12d2f2d01", "0x379f36a21", "0x6973f59ac", "0x7789ea9f4",
  "0x8f1c73e84", "0x8dd287a20", "0x94a4eee4c", "0xa455379b5", "0xa9e92987d", "0xbd25cb40b", "0xbe98d3582", "0xd3d5972b2", "0x14c53d7c7", "0x4f1796936",
  "0x4e71fed1a", "0x66d46fae0", "0xa55abb933", "0xebee1acca", "0x1ad4ba6a4", "0x305b17571", "0x553611351", "0x59ca62775", "0x7819cb6a1", "0xedb7bc9eb",
  "0x5b2694212", "0x72e12d185", "0xed6152e2c", "0x5bcdadbf3", "0x78e0aa0c6", "0xc60a0b909", "0xef9a34b0d", "0x398a6621a", "0xa8a27c944", "0x4b564304e",
  "0x52902b4e2", "0x857280b56", "0xa91b2c84b", "0xe91df939b", "0x1fa405f28", "0x23793ab86", "0x68c17729f", "0x9fbf3b840", "0x36922413c", "0x4eb5f946e",
  "0x533fe2404", "0x63de7d35e", "0x925eddc72", "0x99b8b3896", "0xaace4c708", "0xc22994af0", "0x8f1eae41b", "0xd95fb486c", "0x13fb77857", "0x4fe0983a3",
  "0xd559bf8a9", "0xe1855d78d", "0xfec8daaad", "0x71ecb6d95", "0xdc9e50e4c", "0xca3a4c259", "0x740d12bbf", "0xaeedd18e0", "0xb509b9c8e", "0x5232fea1c",
  "0x19282d18b", "0x76c22d67b", "0x936beb34b", "0x8a5ea8dd", "0x679eadc28", "0xa08e119c5", "0x20a6e3e24", "0x7eab9c239", "0x96632c32e", "0x470d06e44",
  "0x8a70212fb", "0xa7e4251b", "0x9ec762cc0", "0xd8a3a1f48", "0xdb680f346", "0x4a1e93a9d", "0x638ddc04f", "0x4c2fcc993", "0x1ef28c95", "0xbf0d9792d",
  "0x6d27557c3", "0x623f977f4", "0x35b43be57", "0xbb0c428d5", "0xa6f01474d", "0x5a70c9749", "0x20ddabc3b", "0x2eabd78cf", "0x90aa18f88", "0xa9ea89350",
  "0x3cdb39b22", "0x839a08f34", "0x169bb814e", "0x1a575ab08", "0xa04d3d5a2", "0xbf7902f2b", "0x95a5e65c", "0x92e8fce94", "0x67ef48d12", "0x6400dbcac",
  "0xb12d8fb9f", "0x347f45d3", "0xb35826f56", "0xc546ac6e4", "0x81cc35b66", "0x41d14bd57", "0xc052b168", "0x7d6ce5018", "0xab4ed5ede", "0x5af817119",
  "0xd1454b182", "0x2badb090b", "0x3fcb4c0c", "0x2f1c28fd8", "0x93608c6f7", "0x4c93ba2b5", "0x7d950a5d", "0xe54b3d3fc", "0x15560cf9d", "0x189e4958a",
  "0x62140e9d2", "0x723bc1cdb", "0x2063f26fa", "0xfa08ab19f", "0x7955641db", "0x646b01daa", "0x71cd427cc", "0x9a42f7d4", "0x717edc643", "0x15eb94367",
  "0x8392e6bb2", "0x832408542", "0x2b9b874be", "0xb21f4730d", "0xb5d8f24c9", "0x7dbaf6931", "0x1b4e33629", "0x13452e710", "0xe974af612", "0x1df61d29a",
  "0x99f2532ad", "0xe50ec71b4", "0x5df0a36e8", "0x4934e4cea", "0xe34a0b4bd", "0xb7b26b588", "0xf255118d", "0xd0c8fa31e", "0x6a50c94f", "0xf28aa9f06",
  "0x131d194d8", "0x622e3da79", "0xac7478303", "0xc8f2521d7", "0x6c9c881f5", "0x49e38b60a", "0x513d8df65", "0xd7c2b0785", "0x9f6f9d75a", "0x9f6966020",
  "0x1e1a54e33", "0xc04d63419", "0x946e04cd7", "0x1bdac5902", "0x56469b830", "0xffad59569", "0x86970e7d8", "0x8a4b41e12", "0xad4688e3b", "0x85f8f5df4",
  "0xd833a0893", "0x2a36fdd7c", "0xd6a857cf2", "0x8829bc35c", "0x5e50d79bc", "0xfbb8035e4", "0xc1a95bebf", "0x36b0baf8", "0xe0da964ea", "0xb6483689b",
  "0x7c8e2f4c1", "0x5b856a23b", "0x2fc183995", "0xe914b6d70", "0xb31041969", "0x1bb478493", "0x63e2b456", "0xf2a082b9c", "0x8e5e646ea", "0x8172f8f6",
];

/** bit i の x（列。1〜6）。tag36h11.c の bit_x */
const BIT_X = [1, 2, 3, 4, 5, 2, 3, 4, 3, 6, 6, 6, 6, 6, 5, 5, 5, 4, 6, 5, 4, 3, 2, 5, 4, 3, 4, 1, 1, 1, 1, 1, 2, 2, 2, 3];
/** bit i の y（行。1〜6）。tag36h11.c の bit_y */
const BIT_Y = [1, 1, 1, 1, 1, 2, 2, 2, 3, 1, 2, 3, 4, 5, 2, 3, 4, 3, 6, 6, 6, 6, 6, 5, 5, 5, 4, 6, 5, 4, 3, 2, 5, 4, 3, 4];

/** この表にある ID の数（0〜249。tag36h11 自体は 587 個ある） */
export const TAG36H11_COUNT = CODES.length;

/**
 * 黒枠の内側のビット（6×6）。[行][列]、上の行から。true = 白いセル。
 * 08 の markerBits（marker-detector.ts）と同じ形なので fake-markers.ts の FakeMarker.bits にそのまま渡せる
 */
export function tag36h11Bits(id: number): boolean[][] {
  const hex = CODES[id];
  if (hex === undefined) throw new Error(`tag36h11 の ID ${id} はこの表（0〜${CODES.length - 1}）にありません`);
  const code = BigInt(hex);
  const rows: boolean[][] = [];
  for (let y = 0; y < 6; y++) rows.push([false, false, false, false, false, false]);
  for (let i = 0; i < 36; i++) {
    const v = (code >> BigInt(35 - i)) & 1n;
    rows[BIT_Y[i] - 1][BIT_X[i] - 1] = v === 1n;
  }
  return rows;
}

/**
 * 10×10 セルの絵柄を文字列で返す（"#" = 黒、"." = 白。行ごとに改行）。公式 PNG との照合とデバッグ用
 */
export function tag36h11Ascii(id: number): string {
  const bits = tag36h11Bits(id);
  const rows: string[] = [];
  for (let y = 0; y < 10; y++) {
    let row = "";
    for (let x = 0; x < 10; x++) {
      const inTag = x >= 1 && x <= 8 && y >= 1 && y <= 8;
      const inBits = x >= 2 && x <= 7 && y >= 2 && y <= 7;
      row += !inTag || (inBits && bits[y - 2][x - 2]) ? "." : "#";
    }
    rows.push(row);
  }
  return rows.join("\n");
}

/**
 * 印刷用の SVG。08 の markerSvg（js-aruco2 の generateSVG）と同じ描き方: 白い余白 1 セル + 黒い正方形 8 セル + 白いビット。
 * 黒い正方形は全体の 8/10（markers.html の CSS はこの前提で 10/8 倍の大きさに描く）
 */
export function tag36h11Svg(id: number): string {
  const bits = tag36h11Bits(id);
  let svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" shape-rendering="crispEdges">';
  svg += '<rect x="0" y="0" width="10" height="10" fill="white"/>';
  svg += '<rect x="1" y="1" width="8" height="8" fill="black"/>';
  for (let y = 0; y < 6; y++) {
    for (let x = 0; x < 6; x++) {
      if (bits[y][x]) svg += `<rect x="${x + 2}" y="${y + 2}" width="1" height="1" fill="white"/>`;
    }
  }
  svg += "</svg>";
  return svg;
}
