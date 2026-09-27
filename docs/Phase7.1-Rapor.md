# Phase 7.1 — Aktif late join ve oda geçişi

Phase 7.1 tamamlandı. Kapsam yalnızca katılım politikası, güvenli katılım spawn'ı, oda navigasyonu ve yaşam döngüsü. Phase 8'e başlanmadı. Önceki çalışma ağacındaki değişiklikler korundu; commit/reset/rebase yapılmadı.

## İstenen 18 maddelik sonuç raporu

1. **Late join neden hareket edemiyordu?** `GameModeSystem.addPlayer`, yalnızca LOBBY katılımını participant kabul ediyordu. PLAYING katılımında `participant=false` kalınca server input'u reddediyor, client kontrolleri kapatıyor ve HUD oyuncuyu standings dışında bırakıyordu.

2. **Yeni mid-round policy:** PLAYING katılımı hemen `participant=true`; normal araç ve kontroller etkin. COUNTDOWN katılımı aynı round'un participant'ı; kontroller PLAYING başladığında açılıyor. Yeni oyuncunun trailer/current streak/best streak ticks ve session points değerleri sıfır. Reconnect mevcut oyuncuyu yeniden yaratmadığı için mevcut session points korunuyor. Compensation score yok. Normal spawn havuzunda dolu noktalar collider sorgusuyla atlanıyor; havuz convoy nedeniyle doluysa aynı spawn bölgesindeki sınırlı ek sıralar deneniyor. Araç sıfır linear/angular velocity ile oluşturuluyor. Chassis, controller ve collision ayarları normal oyuncuyla aynı.

3. **Standings:** Yeni participant normal game-state player listesine giriyor. Join onayından sonra hemen tam world snapshot yayınlanıyor; tüm client'lar oyuncuyu sıfır trailer time ile görüyor. Normal trailer desteği ve sıralama kuralları uygulanıyor.

4. **Timer:** Join, round başlangıcını/bitişini, round numarasını veya mevcut oyuncuların skorunu değiştirmiyor. Round süresi 90 saniye. Otomatik testte 50 saniye kalan round doğrulandı. Tarayıcı testinde katılım öncesinde `00:44`, sonraki okumada iki client'ta aynı `00:34` görüldü; yeni oyuncunun trailer time'ı `0.0s` → `10.5s` → `13.8s` arttı. Ek tarayıcı testinde geç katılan araç gerçek W tuşu girişleriyle ilerledi. İki oyunculu mevcut DEV collision senaryosu çalıştırıldı; ayrıca otomatik test gerçek Rapier çarpışması, RAM olayı ve araç yer değiştirmesini doğruladı.

5. **RESULTS join:** Oyuncu odaya giriyor, tamamlanmış round'un results listesine eklenmiyor ve sonuçları değiştirmiyor. Sonraki round başlarken participant oluyor. Bu davranış ve COUNTDOWN'un son tick'inde katılım otomatik testlerle doğrulandı.

6. **Leave protocol:** Mevcut typed `{ type: 'leave_room' }` kullanılıyor. Server sahipliği socket/session üzerinden belirliyor; client'tan playerId alınmıyor. Server cleanup'tan sonra typed `room_left` ve yeni session token gönderiyor. Client oyun durumunu ancak bu ACK sonrasında temizliyor. Bekleyen aksiyon boyunca tekrar leave/join/create ve gameplay input gönderimi engelleniyor. ACK beş saniyede ulaşmazsa bağlantı güvenli hata/menü kurtarma akışına geçiyor; server reddederse mevcut session korunuyor.

7. **Intentional leave / disconnect:** Leave, oyuncuyu/araç/scoring/membership'i hemen kaldırıyor; 15 saniyelik oda rezervasyonu başlatmıyor. Unexpected disconnect mevcut grace/reconnect akışını kullanıyor. DEV 5s ve 16s düğmeleri korundu; 16s düğmesi 15s grace expiry'yi test ediyor.

8. **Session token:** Leave isteği sırasında eski token otomatik resume için kullanılmaz. ACK eski capability'yi geçersiz kılıp oda üyeliği olmayan yeni capability sağlar. WebSocket açık kalır. ACK sonrası transport reconnect veya refresh yalnızca bu boş session'a dönebilir. ACK gelmeden bağlantı koparsa eski oda token'ıyla resume denenmez. Böylece session ile room membership ayrı kalır.

9. **Client cleanup:** Local/remote araçlar, convoy, leaderboard, round timer, results/lobby/ready state, room code, transient RAM efektleri, input sequence ve eski debug oda telemetrisi temizleniyor. Name, sound tercihi ve genel UI ayarları oda geçişinde korunuyor. Tarayıcıda leave sonrası name korundu, SOUND OFF kaldı, HUD gizlendi ve ROOM SELECT açıldı.

10. **Prediction cleanup:** Mevcut `World.clear()` yolu araç/convoy snapshot buffer'larını, interpolation clock'u, prediction history/pending input/correction state'ini temizliyor. Yeni `room_joined` tam temiz başlangıç yapıyor. Prediction algoritmaları değiştirilmedi. Otomatik testler gerçek World nesnesinde eski history/buffer taşınmadığını doğruladı. Tarayıcı menüsünde pending inputs `0`, snapshot buffer `0`, visual correction `0.000m`, local writer `NONE · 0 writes · 0 conflicts` görüldü.

11. **Room A → Room B:** Tarayıcıda aynı A sekmesi `294N4L` → Leave → ROOM SELECT → `P8W9U6` akışını tamamladı. Yeni player kimliği ve yalnızca yeni oda oyuncuları gösterildi. Otomatik test aynı socket'in açık kaldığını ve oda içindeyken izinsiz ikinci join'in reddedildiğini doğruluyor.

12. **Leave → Create:** Aynı A sekmesi ikinci odadan çıkıp `5SA35K` kodlu yeni oda oluşturdu. Eski oda kodları tekrar kullanılmadı. Otomatik test empty-room cleanup ve yeni oda oluşturmayı da doğruluyor.

13. **Host leave:** Playing sırasında A'nın çıkışı sonrası C host oldu ve NEXT ROUND kullanabildi. Ek testte C'nin çıkışı sonrası B host oldu. Dört fazdaki otomatik testler immediate migration'ı ve eski host üyeliğinin kaldırılmasını doğruluyor. Son oyuncu leave sonrası health endpoint `rooms=0`, `players=0` gösterdi.

14. **5 sec reconnect:** Oda içindeki tarayıcı testinde A aynı `player_c6c6e0c4-3541-4196-bf51-fc11a5a9a276` kimliğiyle `5SA35K` odasına döndü. Duplicate player/vehicle oluşmadı. Otomatik reconnect testleri geçti. Leave ACK sonrasında menüde yapılan 5s disconnect de boş session'a döndü; eski odaya katılmadı.

15. **15 sec expiry:** Sabit son sürümde DEV 16s kopuş testi çalıştırıldı. Client FAILED ve kurtarma düğmesi gösterdi; `DV4C5U` tek kişilik odası/player'ı server'dan temizlendi. RETURN TO LOBBY ardından başka odaya katılım çalıştı. Otomatik grace sınırı/temizlik testleri geçti.

16. **Refresh:** Oda içi refresh aynı player kimliğini ve oda üyeliğini korudu. Leave ACK sonrası menü refresh'i CONNECTED/ROOM SELECT olarak kaldı; local player ve room code boştu. Eski odaya dönülmedi. Otomatik refresh/capability testleri de geçti.

17. **Automated checks:** 21 test dosyasında **326/326 test geçti**: client 124, server 202. Önceki toplam 305'e 21 test eklendi. Eski late-join beklentileri yeni katılım sözleşmesine, eski leave testi ACK öncesi güvenli kopuş sözleşmesine uyarlandı; testler silinmedi. `pnpm typecheck`, `pnpm build`, `pnpm test`, `pnpm lint`, `pnpm format:check` başarılı. Build'de mevcut büyük bundle uyarısı var; hata değil. Build'in shared dist'i temizlediği anla çakışan ilk test çalıştırması yeniden, build bittikten sonra yapıldı; yukarıdaki sonuç son başarılı çalıştırma.

18. **Phase 8 öncesi blocker:** Phase 7.1 kapsamındaki kontrollerde bilinen blocker yok. Bu yeni sürümün kullanıcı kabul testi henüz alınmadı. Physics/RAM/prediction tuning, arena/wheel/audio kaynakları, scoring formula ve 90s duration korundu. Başlangıç SHA-256 kayıtlarına göre 100 mevcut apps/packages dosyası aynı kaldı; 15 mevcut dosya değişti, iki yeni server dosyası eklendi. VehicleSpawner/VehicleSystem değişiklikleri yalnızca seçilmiş spawn noktasını normal araç oluşturma yoluna iletmek için. Phase 8'e geçilmedi; burada duruldu.

Tarayıcı kontrolleri geliştirme sürümünde `http://localhost:5173/`, HTTP/WebSocket server `localhost:3000` üzerinde yapıldı. Build sırasında Vite'nin shared import'ları yenilemesiyle kesilen grace testi, build tamamlandıktan sonra sabit sürümde tekrarlandı. Kullanıcının önceki gerçek browser kabul testi Phase 7 için geçerlidir; bu rapordaki yeni browser kontrolleri agent tarafından yapıldı.
