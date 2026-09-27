# Phase 8 — Production hazırlığı sonuç raporu

Phase 8 yalnız deployment/config/transport/paketleme kapsamındadır. Gerçek hosting provider'a deploy yapılmadı, hesaba giriş yapılmadı. Phase 9 başlatılmadı. Stable Git HEAD `db61d42` korundu; commit, reset ve rebase yapılmadı.

1. **Production architecture.** Static HTTPS browser client → WSS → TLS reverse proxy → dedicated Node game server. Rapier 60 Hz, physics, RAM, score, round ve timer server authoritative kalır. Lobby host sadece oda yetkilisidir. Room/session state bellekte ve tek server instance üzerindedir; restart aktif odaları ve session'ları siler.

2. **Server production start.** Önce `pnpm build:server`; ardından runtime'da `NODE_ENV=production`, `HOST=0.0.0.0`, `PORT` ve `ALLOWED_ORIGINS` vererek `pnpm start:server`. Bu komut compiled `node dist/main.js` çalıştırır. Alternatif: `node apps/server/dist/main.js`. Development watcher kullanılmaz.

3. **Client production build.** Public endpoint'i build öncesinde `VITE_WS_URL=wss://...` olarak ayarla, `pnpm build:client` çalıştır. Çıktı `apps/client/dist`. Root `pnpm build` shared/client/server build'lerini birlikte alır. PowerShell ve env-file örnekleri README'dedir.

4. **Environment variables.** Server: `NODE_ENV`, `HOST`, `PORT`, `ALLOWED_ORIGINS`, `ALLOW_NO_ORIGIN`, `LOG_LEVEL`, `SESSION_GRACE_MS`, `HEARTBEAT_INTERVAL_MS`, `HEARTBEAT_TIMEOUT_MS`, `SHUTDOWN_TIMEOUT_MS`. Client: build-time `VITE_WS_URL`, Vite `DEV`. Production'da PORT ve origin listesi zorunludur. Grace **15000 ms**, heartbeat interval **5000 ms**, timeout **15000 ms**, shutdown timeout **5000 ms** varsayılanları korunmuştur. Örnek env dosyaları secret içermez; VITE değerleri public'tir.

5. **WebSocket URL strategy.** Merkezi `ClientConfig` mevcut URL çözümleyicisini kullanır. Development'ta env gerekmeksizin page host + port 3000 çalışır. Production'da ayrı static/server hostları için explicit `VITE_WS_URL` kullanılır. Mevcut same-origin fallback korunmuştur: URL verilmezse page host/protocol kullanılır; production localhost'a sabitlenmez. Endpoint değişirse yeniden build gerekir. Hatalı absolute URL build/runtime sırasında anlaşılır hata verir.

6. **WS/WSS strategy.** `ws://` ve `wss://` desteklenir, proxy path kullanılabilir. HTTPS page'de insecure WS reddedilir. Local static test HTTP + WS üzerinden yapıldı. Gerçek public HTTPS/WSS, sertifika ve proxy uçtan uca testi bu fazda yapılmadı.

7. **HTTP/WebSocket port.** Tek HTTP server aynı env PORT üzerinde health/readiness ve WebSocket upgrade sunar. `HOST=0.0.0.0`, `PORT=39000` ile gerçek listener kontrol edildi; loopback dışındaki bind desteği doğrulandı. Public internet erişimi ayrıca provider/firewall/proxy ayarlarına bağlıdır.

8. **Health endpoint.** `GET /health` ve `/ready`: `status`, toplam `rooms`, grace üyeliğini de içeren `players`, saniye cinsinden `uptime`. Token/kimlik/room detayları yoktur; `Cache-Control: no-store`, wildcard CORS yoktur. Simulation initialize olmadan OK verilmez. Shutdown sırasında readiness 503 olur. HTTP endpoint ve Node healthcheck başarıyla test edildi.

9. **Origin validation.** Production'da comma-separated exact HTTP(S) origin allowlist; path, credentials, wildcard, yanlış scheme ve suffix eşleşmesi reddedilir. Yanlış veya eksik browser Origin, session yaratılmadan HTTP 403 alır. Development loopback origin'lerine izin verir. Gelecekte native clients için `ALLOW_NO_ORIGIN=true` explicit opt-in vardır. Origin kontrolü account authentication değildir.

10. **maxPayload.** Mevcut **16 KiB / 16384 byte** sınır korundu; küçük game mesajları için daha yüksek bir limite ihtiyaç yoktu. Limit üzerindeki frame, gerçek socket testinde 1009 ile kapandı ve server sağlıklı kaldı. Mevcut malformed payload, max 8 player, rate protection, token validation, heartbeat ve cleanup kontrolleri korundu.

11. **Compression.** `perMessageDeflate=false` explicit. Sık/küçük snapshot ve input mesajlarında başlangıç için CPU/latency maliyeti eklenmedi. Gerçek handshake'te compression extension bulunmadığı doğrulandı.

12. **Dockerfile.** Multi-stage builder/runtime. Node **24.21.0 bookworm-slim** exact digest ile, pnpm root `packageManager` içindeki **11.19.0** sürümüyle sabit. Frozen lockfile install → shared/server compile → `pnpm deploy --legacy --prod`. Bu pnpm sürümünün deploy çıktısındaki dış shared linki, `materialize-shared.mjs` ile compiled shared paketine dönüştürülür. Runtime production dependencies + compiled code içerir, non-root `node` kullanıcısıyla çalışır. PORT runtime'dan gelir; Node HEALTHCHECK vardır. `.dockerignore` node_modules/dist/Git/local env/log/system dosyalarını hariç tutar.

13. **Docker build sonucu.** Bu bilgisayarda Docker CLI/runtime bulunmadı; **docker build/run çalıştırılamadı**. Docker image başarılı test edildi iddiası yoktur. Ayrı olarak pnpm production deployment paketi oluşturuldu, bütün runtime dependency yollarının paket içinde kaldığı kontrol edildi ve bu paketin compiled entrypoint'i tam production smoke testini geçti. Bu kontrol Linux container testinin yerine geçmez.

14. **Production server smoke.** `pnpm smoke:server` başarılı. İzole compiled production server, health/readiness, origin rejection, connect/create/join/ping/snapshot, malformed JSON, iki hareket eden oyuncu, round start, late join, same-socket room geçişi, host migration, leave sonrası menu resume, token log sızıntısı kontrolü ve empty-room cleanup doğrulandı. DEV komutlarına dayanmaz. Compiled startup için yanlış env safe failure testi de geçti.

15. **Production client testi.** Vite production build local static preview'de `http://127.0.0.1:4180` üzerinden, build-time `ws://127.0.0.1:39000` endpoint'iyle compiled server'a bağlandı. Client asset adları hashed; public `.map` dosyası sayısı **0**. Debug panel HTML build aşamasında da hidden. Local test bundle'ı public deployment öncesi gerçek WSS adresiyle yeniden build edilmelidir. Vite'ın mevcut büyük bundle uyarısı build'i engellemedi.

16. **Two-client testi.** İki gerçek production browser aynı `2LYJBN` odasına katıldı, ready oldu, host round başlattı. İki HUD'da aynı timer ve iki oyunculu standings görüldü; sound ve Leave Room erişilebildi, klavye input kabul edildi. İki oyuncunun fiziksel konum değişimi ve input acknowledgement ayrıca gerçek WebSocket smoke testinde assert edildi.

17. **Production reconnect.** Compiled server'da gerçek socket disconnect sonrası **5 saniye** beklenerek session resume yapıldı: aynı UUID/room, iki oyuncu/body, önceki timer ve migrated host korunarak dönüş doğrulandı. Production browser refresh de aynı oda ve iki oyunculu HUD'a döndü. Session/grace/retry algoritmaları değiştirilmedi.

18. **Graceful shutdown.** Testler shutdown'da readiness 503, socket close 1001, oda disposal ve initialize/shutdown yarışında yeni listener açılmamasını doğruladı. Compiled Node'a gerçek console SIGINT gönderildi: `shutdown complete`, listener kapalı, exit-event probe ile **Node exit code 0** görüldü. Windows PowerShell/PTY dış katmanı Ctrl+C için 1 döndürdü; bu Node'un çıkış kodundan ayrıdır. Unix SIGTERM/container stop delivery Docker olmadığı için yerel olarak test edilmedi. Fatal error/rejection yolu redacted error log + başarısız process exit üretir.

19. **Production DEV araçları.** Prediction/debug internals, physics telemetry, network simulation, forced disconnect, force resync ve diğer debug panel kontrolleri normal kullanıcıya gizlidir. Normal lobby/room/leave/timer/standings/results/sound HUD kodu korunur. Development'ta debug panel görünür; `pnpm dev` env dosyası olmadan çalıştırılıp CONNECTED durumu doğrulandı.

20. **README deployment değişiklikleri.** Provider-independent static client ve compiled Node/Docker komutları, build-time env, TLS/WSS reverse proxy, health/readiness, shutdown/fatal handling, exact origins/native opt-in, single instance/in-memory restart davranışı, lobby host ayrımı, yakın region ve cache politikası eklendi. Hashed assets uzun immutable cache alabilir; index.html revalidation/short cache kullanmalıdır. Multi-instance/matchmaking/account/DB/Redis eklenmedi.

21. **Önemli dosyalar.** `Dockerfile`, `.dockerignore`, `README.md`, root/server `package.json`, `pnpm-workspace.yaml`; server `ServerConfig`, `OriginPolicy`, `ServerLogger`, `GameServer`, `main`; client `ClientConfig`, `ConnectionConfig`, `vite.config`, `main` ve Game config bağlantısı; iki `.env.example`; `scripts/smoke-server.mjs`, `healthcheck.mjs`, `materialize-shared.mjs`; yeni production/config/transport testleri. ConnectionManager/RoomManager yalnız logging açısından değişti. Lockfile ve dependency sürümleri değişmedi.

22. **Automated sonuç.** **361/361 test: client 133, server 228; 25 test dosyası.** Önceki 326 test korundu, 35 deployment testi eklendi. Son kaynak değişikliğinden sonra `pnpm typecheck`, `pnpm build`, `pnpm test`, `pnpm lint`, `pnpm format:check` başarılı. Production smoke ve taşınabilir production package smoke da başarılı.

23. **Gameplay regression.** Başlangıçtaki 117 apps/packages dosyasından 104'ü SHA-256 olarak aynı kaldı. Değişen 13 mevcut dosya env/config/entrypoint/build/test fixture/logging kapsamındadır. Physics, vehicle tuning, steering, RAM, trailer, scoring, rounds, GameRoom/GameMode, rendering, audio ve shared gameplay/protocol dosyaları değiştirilmedi. Mevcut physics/gameplay/Phase 7.1 room lifecycle testleri geçti. Kullanıcının önceki manuel feel onayı korunmuştur; yeni kullanıcı manuel onayı varsayılmadı.

24. **Prediction regression.** Prediction algoritmaları, input history/transmitter, snapshot/world uygulaması, NetworkClient/session registry ve reconnect gecikme sabitleri değişmedi. Mevcut prediction/reconnect testleri ve production reconnect smoke geçti. Client Game değişikliği yalnız merkezi config'den WebSocket URL alınmasıdır; prediction feel/tuning müdahalesi yapılmadı.

25. **Actual deployment öncesi durum.** Phase 8'in local build/test ve infrastructure kapsamı tamamlandı. Yerel kod/test başarısızlığı yok. Gerçek dağıtımdan önce Docker bulunan ortamda image build/run, non-root runtime ve container SIGTERM/HEALTHCHECK doğrulanmalı; gerçek domain, public WSS/TLS/proxy, PORT/origin/firewall ayarları yapılmalı, client public URL ile yeniden build edilmeli ve dış ağdan iki-client smoke uygulanmalı. Bunlar bu fazda gerçekleştirilmiş bir public deployment değildir. **Phase 9'a geçilmedi; burada duruldu.**
