import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import basicSsl from '@vitejs/plugin-basic-ssl'

// iOS Safari はセンサー/カメラ API が HTTPS 必須のため、dev サーバーを
// 自己署名 HTTPS + LAN 公開で立てる（iPhone 側は初回のみ証明書警告を突破する）
export default defineConfig({
  plugins: [basicSsl()],
  server: {
    host: true,
  },
  build: {
    rollupOptions: {
      // マルチページ構成: デモを追加したらここに登録する（new-demo スキル参照）
      input: {
        home: fileURLToPath(new URL('./index.html', import.meta.url)),
        'demo-01-stereo-box': fileURLToPath(
          new URL('./demos/01-stereo-box/index.html', import.meta.url),
        ),
      },
    },
  },
})
