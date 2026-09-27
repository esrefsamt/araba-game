# Phase 9 — Yayın kontrolü

**Durum: provider seçimi ve hesap erişimi bekleniyor. Gerçek public deployment henüz yapılmadı; Phase 9 tamamlandı sayılmaz. Phase 10 başlatılmadı.**

Git başlangıç kontrolünde HEAD `db61d42` (Stable Phase 7.1 multiplayer room lifecycle) bulundu. Phase 8 değişiklikleri çalışma ağacında, commit edilmemiş durumdadır; korunmuştur. Git remote tanımlı değildir. Commit/reset/rebase yapılmadı. Yeni çalışmalar yalnız doğrulama script'i, package komutu ve deployment dokümantasyonudur; gameplay kaynaklarına dokunulmadı.

Hazırlık doğrulaması: `pnpm typecheck`, `pnpm build`, `pnpm test`, `pnpm lint`, `pnpm format:check` başarılı; **361/361 automated test** (client 133, server 228). Phase 9 başlangıcındaki apps/packages kapsamındaki 124 dosyanın tamamı SHA-256 olarak aynı kaldı. Docker CLI bu ortamda hâlâ mevcut değil; provider/container doğrulaması yapılmadı.

## Deployment için gerekli bilgiler

- Birlikte seçilecek provider, mevcut hesabın durumu ve aylık bütçe sınırı.
- Avrupa region'ı: provider'ın kullanılabilir Northern/Central Europe bölgesi.
- Tek, sürekli çalışan dedicated Node/Docker instance. Serverless function ve horizontal scaling kullanılmaz.
- Public HTTPS static client URL'si ve public WSS game server URL'si.
- Server runtime: `NODE_ENV=production`, `HOST=0.0.0.0`, provider'ın `PORT` değeri, exact HTTPS `ALLOWED_ORIGINS`.
- Client build-time: gerçek endpoint ile `VITE_WS_URL`; `apps/client/dist` static olarak yayınlanır.
- Provider erişimi güvenli bağlantı/login üzerinden sağlanmalı; credential veya full session token chat çıktısına, repository'ye veya dokümana yazılmamalıdır.

Provider seçimi netleşmeden vendor dosyası/SDK'sı eklenmez. Kaynak upload yöntemi seçilen provider'a göre belirlenecek; mevcut Git remote yokluğu da bu adımda ele alınacak. Gerçek adresler doğrulanmadan README'ye başarılı bir Actual Deployment kaydı eklenmez.

## Automated public doğrulama

```bash
pnpm smoke:deployment --server wss://PUBLIC_GAME_SERVER --origin https://PUBLIC_CLIENT
```

Placeholder değerleri gerçek endpoint'lerle değiştirilmelidir. Script:

- Public health, origin handling, handshake, session, create/join/ping/snapshot ve mevcut 5 saniyelik reconnect smoke'unu çalıştırır.
- İki automated bağlantı için yedi RTT sample, median/min/max raporlar.
- Normal 90 saniyelik round'u oynatır; altı oyuncuyu mid-round ekler, 8-player cap ve 9. oyuncu rejection'ını doğrular.
- İki bağlantının aynı tick'teki complete authoritative world snapshot'larını karşılaştırır; vehicle/convoy/game state aynıdır. Input acknowledgement ve iki araçtaki hareketi kontrol eder.
- Gözlenen snapshot rate ve simulation tick hızını ölçer; bunlar browser render FPS'i değildir.
- Gerçek 17 saniye bekleme ile grace expiry ve host migration'ı doğrular.
- İki client'ın results/session score bilgisini karşılaştırır, next round başlatır, test odasını boşaltır ve kaldırıldığını doğrular.
- Çıktıya full session token eklemez; public provider loglarını okuduğunu iddia etmez.

Local rehearsal ayrı ve explicit'tir:

```bash
pnpm smoke:deployment --server ws://127.0.0.1:39000 --origin http://127.0.0.1:4180 --local-test
```

Local başarı gerçek public WSS, provider/container, iki farklı bilgisayar veya gerçek oyuncu RTT sonucu değildir.

Yerel compiled production server üzerinde rehearsal başarılı oldu: 8 player, 9. player `ROOM_FULL`, altı mid-round join, iki hareket eden araç, 80 aynı authoritative frame, tam 90 saniyelik round, eşit results, next round, 17 saniye sonrası `SESSION_EXPIRED`, host migration ve room cleanup. Gözlenen snapshot hızları 20.05/20.04 Hz, simulation tick hızları 60.14/60.13 Hz idi. İki loopback automated probe'un median RTT'si 0.43/0.43 ms; bu değerler Player A/B'nin internet RTT'si değildir. Maç sırasında health `rooms=1,players=8`; temizleme sonunda `rooms=0,players=0`, status OK idi. Public modda insecure WS kullanımının güvenli biçimde reddedildiği ayrıca kontrol edildi.

## Gerçek deployment sonrası yapılacak testler

1. Public `/health` ve `/ready` HTTP 200, `status=ok`; aktif maçta mantıklı room/player counts.
2. HTTPS client asset yüklenmesi, WSS CONNECTED, oda create/join; iki ayrı bilgisayar/ağdan karşılıklı görünme ve hareket.
3. Artificial network simulation kapalı, prediction açık; Player A ve B'nin gerçek RTT değerlerini ayrıca kaydet.
4. İki oyuncuyla driving, collision, RAM knockback/rollover, ramp ve moving trailer jitter/sliding testi. Görsel teleport/desync kontrolü.
5. Trailer üzerinde scoring içeren Lobby → Ready → Countdown → Playing → Results → Next Round; standings/session score eşitliği.
6. Mid-round üçüncü oyuncu, same-tab Room A → Leave → Menu → Room B, host migration.
7. Browser refresh, yaklaşık 5 saniyelik bağlantı kaybı, 15 saniye üzeri grace expiry; duplicate player/body olmaması.
8. Provider logs'ta session token bulunmaması; connect/join/cleanup; 2–4 oyuncuyla CPU/RAM/restarts, empty-room cleanup.
9. Docker seçilmişse gerçek image build/start, non-root kullanıcı, runtime PORT, HEALTHCHECK ve container SIGTERM. Node seçilmişse provider process shutdown/restart.
10. Restart'ta in-memory room kaybı ve stale session'dan recoverable main-menu dönüşü.
11. Public DEV paneli gizli; normal game HUD mevcut. Browser console'da mixed content/origin/failed WS/missing assets/uncaught errors/AudioContext spam olmaması.
12. Hashed assets, index.html revalidation ve yeni deployment'ta eski bundle'ın yüklenmemesi.
13. `pnpm typecheck`, `pnpm build`, `pnpm test`, `pnpm lint`, `pnpm format:check`.

Sonuç raporundaki 27 madde ancak gerçek provider/endpoint ve test sonuçları elde edilince doldurulacaktır. Yapılmamış public testler başarılı olarak işaretlenmeyecek.
