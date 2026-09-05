---
name: dev-address
description: iPhone など別の端末から dev サーバーを開く URL を答える。「アドレス教えて」「URL 教えて」「どこ開けばいい」「スマホで見たい」と言われたとき、または実機に URL を渡すときに使う。答えは必ず `https://<ホスト名>.local:<ポート>/` の形にし、IP 直打ち（`https://192.168.x.x:5173/`）では答えない。
---

# dev サーバーのアドレスを答える

実機確認のたびに URL を聞かれる。**答える形はいつも同じ**にする:

```text
https://na2keraMacBook-Air.local:5173/demos/08-splatoon/
```

`<ホスト名>.local`（Bonjour / mDNS）は Mac の IP が変わっても同じなので、**IP 直打ちでは答えない**。
Vite の起動ログの `Network:` 行（`https://192.168.100.161:5173/`）をそのまま渡さないこと — Wi-Fi を変える・再接続するたびに変わり、このプロジェクトで実際に 2 回「開けない」が起きている。

## 手順

### 1. ホスト名を取る

```bash
scutil --get LocalHostName    # → na2keraMacBook-Air
```

ハードコードせずこれで取る（ユーザーが Mac 名を変えても追従する）。`.local` は大文字小文字を区別しないので `na2keramacbook-air.local` でも同じ。

### 2. ポートと「どの worktree が配っているか」を確認する

このプロジェクトは worktree を複数使うので、**別の worktree の dev サーバーが同じポートを掴んだまま**になっていることがある。
その状態で URL を渡すと、ユーザーは実機で**別ブランチのコード**を見ることになる（気づきにくい）。必ず確認する:

```bash
lsof -nP -iTCP:5173 -sTCP:LISTEN                      # 誰が 5173 を持っているか
lsof -p <PID> -a -d cwd | tail -1                     # その dev サーバーの worktree
```

- 目的の worktree のものなら、そのポートを使う
- **別の worktree のものだった場合**: 勝手に kill せず、ユーザーに「いま 5173 は `<別の worktree>` が配っている。止めて良いか / 別ポートで立てるか」を聞く
- 立っていなければ起動する（`vite.config.ts` に `server.host: true` があるので `--host` は不要）:

```bash
npm run dev            # ポートを分けるなら: npx vite --port 5174 --strictPort
```

### 3. 疎通を確認してから渡す

提示する前に Mac 自身から叩く（`-k` は自己署名証明書のため）:

```bash
curl -sk -o /dev/null -w '%{http_code}\n' https://$(scutil --get LocalHostName).local:5173/
```

`200` でなければ URL を渡さず、原因（サーバー未起動・ポート違い・別 worktree）を先に潰す。
mDNS の解決そのものを見たいときは `dns-sd -t 5 -G v4 $(scutil --get LocalHostName).local`（LAN の IP が返れば OK）。

### 4. 渡す

トップだけでなく**開いてほしいページの URL をそのまま**渡す。08 なら:

| 誰が | URL |
| --- | --- |
| スマホ（プレイヤー） | `https://na2keraMacBook-Air.local:5173/demos/08-splatoon/` |
| PC（俯瞰画面・マスター） | `https://na2keraMacBook-Air.local:5173/demos/08-splatoon/overview.html` |
| 印刷（マーカー） | `https://na2keraMacBook-Air.local:5173/demos/08-splatoon/markers.html` |
| デモ一覧 | `https://na2keraMacBook-Air.local:5173/` |

`?room=` `?name=` `?handScale=` など、その確認で必要なクエリも付けた形で渡す。

## 開けないと言われたら

上から順に疑う:

1. **同じ Wi-Fi にいるか**（iPhone がモバイル回線・ゲスト SSID に落ちていないか）。`.local` は同じ LAN 内でしか引けない
2. **証明書の警告**: 自己署名（`@vitejs/plugin-basic-ssl`）なので初回は突破が要る。iOS Safari は「詳細を表示 → この Web サイトを閲覧」、Android Chrome は「詳細設定 → アクセスする（安全ではありません）」
3. **dev サーバーが落ちていないか**（手順 2・3 をやり直す）
4. ここまでで駄目なら、**その場しのぎ**として IP 直打ちを案内する（`ipconfig getifaddr en0`）。ただし「次に Wi-Fi が変わると使えなくなる」ことを添える。Tailscale などで `Network:` 行に複数の IP（`utun4` など）が出ることがあり、選ぶべきは `en0` の方

## 関連

- 実機確認の手順・iOS Safari の制約は **iphone-test** スキル
- 実機で見つけた痛点は **pain-point** スキル
