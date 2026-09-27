# Phase 6.1 — Motorsport ortamı ve motor sesi

Tarih: 27 Eylül 2026. Kapsam: yalnızca istemci ortam sunumu ve motor sesi. Phase 7 başlatılmadı. Commit, reset veya mevcut değişiklikleri geri alma işlemi yapılmadı.

Kod ve otomatik kontroller hazır. Tam kabul için kullanıcının yeni motor sesini dinlemesi, bir tam tur sürmesi ve çime çıkış testini yapması gerekiyor. Aşağıdaki tarayıcı kontrolleri, insan tarafından yapılan sürüş/dinleme testinin yerine geçmez.

1. **Eski arena neden park gibi görünüyordu?** Küçük dört basamaklı tribün, infield çadırları, saman balyaları ve pist yakınındaki ağaçlar aynı görsel ağırlıktaydı. Catch fence, büyük seyirci alanı ve yarış operasyonu landmark'ları yoktu. Yerleşim zaten sabit koordinatlar kullanıyordu; sorun rastgele sayı üretiminden çok, tasarımın dağınık okunmasıydı.

2. **Kaldırılan/taşınan dekorlar.** Eski 14 yakın çevre ağacı, sekiz infield saman balyası, küçük tribün, üç infield çadırı ve infield bayrak dizisi değiştirildi. Ağaçlar uzak çevreye; çadırlar seyirci ve servis bölgelerine alındı. Üç eski billboard'un yerini belirli reklam bölgeleri aldı. Fizik rampası ve test bloğu aynı kaldı.

3. **Yeni zone düzeni.** A: z=-58'de, 60 metre genişliğinde ana tribün. B: infield'ın x=-29…-10, z=8…21 bölgesinde kontrol/servis alanı. C: z=58…62'de küçük tribün ve üç yiyecek/seyirci çadırı. D: iki viraj çıkışı ve karşı düzlükte reklamlar. E: seyirci alanının arkasında sekiz araçlık hizalı otopark ve giriş yolu. F: uzak tepe ve ağaç hattı. Bunlar fizik pistinin ölçülerini değiştirmeyen görsel koordinatlardır.

4. **Catch fence üretimi.** Paylaşılan mevcut oval örnekleme fonksiyonundan 96 kapalı segment üretiliyor. Nominal yüksekliği 3,4 metre; merkez çizgisine dış ofseti 18 metre. Asfalt dış kenarından nominal 10 metre çim kaçış alanı bırakılıyor; virajların düz segmentle yaklaşılması nedeniyle segment ortalarında bu mesafe yaklaşık 9,9 metre. Poles, cutout tel paneller ve ince raylar instanced. Bir ortak DataTexture tel örgü izlenimi veriyor; segment başına material üretilmiyor.

5. **Fence collider mı?** Hayır. Environment yalnızca Three.js objeleri oluşturuyor. Rapier body, collider, sensor veya STATIC_WORLD_BOXES girdisi eklemiyor. Çitten geçmek ve asfalt kenarından çime çıkmak fiziksel olarak engellenmiyor. Sürüşle manuel grass testi henüz tamamlanmadı.

6. **Grandstand/crowd.** Ana tribün sekiz; küçük tribün dört oturma sırasına sahip. Basamaklar, metal destekler, ana tribün çatısı ve iki koridor izlenimi var. Seyirciler tek tek insan mesh'leri yerine instanced gövde/baş renk kartları. Toplam 442 seyirci ve 884 kart; dört crowd batch'i. Renk/boş koltuk çeşitliliği deterministik. Her seyirci yalnızca dört üçgen.

7. **Infield.** Kompakt asfalt servis pad'i, görsel servis yolu, race control binası, scoring/timing kulesi, üç destek aracı, iki servis gölgeliği ve marshal post eklendi. Mevcut rampanın (0,0) ve bloğun (0,8) çevresi korunuyor. Dekoratif servis araçları da collider içermez.

8. **Start/finish.** Mevcut progress=0 konumu korundu. Damalı çizgi 16 metre pist genişliğini kapsıyor. Görsel gantry, beş timing ışığı, start/finish kutusu ve özgün tesis tabelası eklendi. Gantry ayakları asfaltın dışında; bütün yapı collider'sız.

9. **Billboard düzeni.** FULL SEND MOTORS sağ viraj çıkışında, GRIP OPTIONAL sol viraj çıkışında, TRACKSIDE SUPPLY karşı düzlükte. Gerçek motorsport markaları kopyalanmadı; tesis adı COUNTY SHUNT MOTOR CLUB. Reklamlar her birkaç metrede tekrar edilmiyor. Sekiz düzenli light pole tesisi tamamlıyor.

10. **Draw calls / triangles / FPS.** Aynı 1280×720 tarayıcı ve odasız sabit başlangıç kamerasında HUD örnekleri: eski Phase 6, 140 draw calls / 2.930 triangles / yaklaşık 240 FPS; son Phase 6.1, 28 calls / 9.350 triangles / yaklaşık 236–240 FPS. Çağrılar %80 azaldı; görünür üçgen sayısı arttı. Venue batch'lerinin geometrisi 7.616 üçgen. Gölgeli fizik objeleri ve araçlar toplam renderer sayısına ayrıca giriyor. İki oyunculu chase/oyun örneklerinde kamera ve araç konumuna göre 117–196 calls, 10.482–12.762 triangles ve yaklaşık 88–200 FPS görüldü. Arka plandaki sekmeler ayrıca 10 FPS'e sınırlandı. Eski sürümle eşleşen iki oyunculu sürüş benchmark'ı bulunmadığı için bu örnekler bir FPS regresyonu sonucu olarak yorumlanmamalı. Uzun süreli ve sekiz oyunculu performans kabulü açık.

11. **Eski engine neden robotikti?** Tek oscillator değildi: triangle fundamental ve hafif detune edilmiş sine overtone vardı. Fakat iki katman da sürekli periyodik ton üretiyordu; noise/pulse doku katmanı yoktu. Hız doğrudan frekansa bağlanıyor, RPM ve vites davranışı modellenmiyordu. Mevcut smoothing tonal karakteri tek başına değiştirmiyordu.

12. **Yeni synthesis mimarisi.** Yuvarlatılmış özel periodic firing waveform + düşük seviyeli triangle harmonic + firing envelope ile modüle edilen filtreli mekanik noise + ayrı filtreli intake noise. Bir ortak deterministik noise buffer tüm motorlarda yeniden kullanılıyor. Dış ses dosyası veya telifli asset yok.

13. **Katman sayısı.** Dört duyulabilir katman, her voice için iki oscillator ve iki looping buffer source. Envelope ve filtreler ek kaynak üretmiyor.

14. **RPM modeli.** Audio-only model, 900 idle / 6.500 üst sınır. Mutlak ileri hız, throttle/load, fren ve reverse bilgisi kullanılıyor. Model taşıt inputlarını veya tuning değerlerini yazmıyor. Invalid/NaN veriler sonlu değerlere çevriliyor.

15. **Fake gears.** Dört sanal vites. Nominal eşikler 5,4 / 10,4 / 15,8 m/s. Eşiklerde 0,45 m/s hysteresis gereksiz vites gidip gelmesini azaltıyor. Vites değişimi yalnızca hedef RPM'i düşürüyor. Reverse ayrı düşük RPM aralığı kullanıyor; fizik transmission eklenmedi.

16. **Filtering/smoothing.** Mekanik katmanda 220 Hz bandpass, intake'ta 410 Hz bandpass, karışımda 440–900 Hz lowpass. RPM yükselişi yaklaşık 0,20 s; düşüşü 0,38 s zaman sabiti kullanıyor. Web Audio frekans, gain ve cutoff değişiklikleri setTargetAtTime ile yumuşatılıyor; oscillator fazı vites değişiminde sıfırlanmıyor. Noise loop kenarları window'lanıyor; remote voice kapatılırken fade uygulanıyor. Motor default mix'i eski fundamental seviyesinden düşük; collision, RAM ve countdown sesleri değiştirilmedi.

17. **Idle sonucu.** RPM/parametre testleri idle'ın fren sırasında da en az 900 RPM kaldığını doğruluyor. Tarayıcıda iki durgun oyuncu ve ses toggle çalıştı. “Daha doğal/yumuşak duyuluyor” şeklinde insan dinleme kabulü henüz yok.

18. **Acceleration sonucu.** Acceleration→cruise→reverse→braking model dizisi test edildi; 60 FPS'te en büyük RPM adımı 250 RPM altında, frekanslar sonlu. Gear shift sırasında kaynak yeniden başlatılmıyor. W ile uzun hızlanmanın algısal dinleme testi açık.

19. **Cruise sonucu.** Sabit hızda noise doku ve küçük cycle variation sürüyor; tek tonal source'a indirgenmiyor. Teknik testler geçiyor. Cruise sesinin rahatsızlık yaratmadığına ilişkin uzun süreli insan değerlendirmesi açık.

20. **Two-player audio sonucu.** İki tarayıcı aynı odaya katıldı, ready/countdown/playing/results akışı ve SOUND ON/OFF kontrolü tamamlandı. Native üretim önizlemesinde console error/warning yok. Remote duyulabilir menzil 40 metre; mesafe rolloff güçlü. Tek remote'ın en yüksek mix katsayısı local'in %16'sı, yedi remote'ın toplamı teorik olarak %43 altında. Bu katsayılar algısal loudness ölçümü değildir. Yan yana sürüşte öznel ses dengesi henüz kullanıcı tarafından onaylanmadı.

21. **Prediction regression.** Mevcut 0 ms authoritative prediction/proxy testleri geçti. Canlı oda network simulation 0 ms, prediction ON durumunda çalıştı; local writer 1 write / 0 conflicts gösterdi. Ağ RTT'si gerçekten sıfır değildi (yaklaşık 1–7 ms). Prediction/reconciliation/network dosyalarının SHA-256 hash'leri görev başlangıcıyla aynı.

22. **RAM regression.** PlayerCollisionSystem ve upright/stability testleri geçti; RAM güç, lateral sliding ve rollover testleri korunuyor. İki oyunculu debug collision düzeni tarayıcıda çalıştırıldı. RAM implementasyonu ve tuning dosyaları bu yama sırasında değiştirilmedi. Önceki baseline ile insan sürüş karşılaştırması yapılmadı.

23. **Trailer regression.** Convoy/trailer/scoring testleri geçti. Canlı odada debug teleport sonrası TRAILER_DECK, dört wheel contact ve ON DECK gözlendi. Countdown→playing→trailer süresi→results akışı tamamlandı; sonuçlar 14,2 s / +10 ve 4,9 s / +7 idi. Bu debug destekli smoke test, doğal ramp çıkışı/tam tur manuel testinin yerine geçmez. Truck speed, ramp, trailer ve scoring kaynakları aynı hash'te.

24. **Automated sonuç.** pnpm typecheck, build, test, lint ve format:check başarılı. 13 test dosyasında 207 test: client 66, server 141. Phase 6.1 için 11 yeni test; deterministic yerleşim, fence sürekliliği/ofseti, collider/shared layout korunması, instance/triangle bütçesi, RPM/hysteresis/NaN, remote mix, noise seam, mute/unlock ve remote voice lifecycle doğrulanıyor. Başlangıçtaki 91 dosyanın 88'i byte olarak aynı; değişen mevcut dosyalar AudioManager.ts, SceneManager.ts ve yalnızca audio bağlantısı için Game.ts. Önceden var olan kullanıcı Phase 6 değişiklikleri korundu.

25. **Blocker ve commit hazırlığı.** Teknik kontrol kaynaklı blocker yok. Tam Phase 6.1 kabulü için insan tarafından motor idle/hızlanma/cruise/iki oyuncu dinleme testi, tam tur arena okunurluğu/grass testi ve aynı koşullarda sürüş FPS karşılaştırması gerekli. Kod incelemeye ve manuel teste hazır; bu kabul tamamlanmadan “bütün acceptance criteria geçti” veya koşulsuz commit-ready denmiyor. Commit alınmadı. Phase 7'ye geçilmedi; çalışma burada duruyor.

Görseller: [arena-overview.jpg](phase61/arena-overview.jpg), [chase-trailer.jpg](phase61/chase-trailer.jpg).
