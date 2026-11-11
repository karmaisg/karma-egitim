# KARMA OSGB Eğitim Platformu

İş sağlığı ve güvenliği eğitimlerini online vermek için web tabanlı eğitim yönetim sistemi.
Cloudflare üzerinde çalışır (Workers + D1 veritabanı). Şifreler asla düz metin saklanmaz.

## Aşama 1 — şu an hazır olanlar

- Yönetici paneli: firmalar (tehlike sınıfı ile), katılımcılar, eğitimler, atamalar
- Eğitim → bölüm → konu yapısı (sıralanabilir)
- Katılımcı girişi (kullanıcı adı + şifre); yalnızca kendine atanan eğitimleri görür
- Şifre otomatik oluşturma ve sıfırlama; yanlış şifre denemesinde geçici kilit (5 deneme → 15 dk)

Sonraki aşamalar: video oynatıcı ve katılım kayıtları (Yön. md. 12/4, 12/5), sınavlar (md. 16/2), PDF katılım belgesi (md. 17).

## Aşama 2 — video ve katılım kayıtları (Yönetmelik md. 12/4, 12/5)

- **Video yükleme:** Eğitim sayfasında her konunun yanındaki "Video" düğmesi. MP4/WebM, parçalar halinde Cloudflare R2'ye (`karma-egitim-videolari`, herkese kapalı) yüklenir. Videolar yalnızca giriş yapmış ve o eğitime atanmış katılımcıya, Worker üzerinden akıtılır; indirme bağlantısı yoktur.
- **Kontrol soruları:** "Sorular" düğmesiyle videonun belirli saniyelerine soru eklenir; doğru cevaplanmadan video devam etmez.
- **İleri sarma engeli:** İlerleme çubuğu tıklanamaz, hız değiştirilemez; sunucu da konumu doğrular. Sekme değişince video duraklar ve kayda geçer.
- **Raporlar:** Yönetici menüsünde "Raporlar": katılımcı bazında ilerleme, izleme süresi, son giriş, ayrıntılı etkinlik günlüğü ve CSV indirme.
- **Kayıt koruma:** İlerleme kaydı olan eğitim/bölüm/konu/video/soru silinemez ve değiştirilemez.
- **Yazılı konular:** En az 5 saniye okuduktan sonra "Konuyu tamamladım" ile tamamlanır.

Cloudflare tarafında R2 kovasının (`karma-egitim-videolari`) var olması gerekir; yoksa video bölümü "503" verir.

## Aşama 3 — sınavlar (Yönetmelik md. 16)

- **Üç tür sınav:** *Ön test* (md. 16/1, seviye tespiti, tek deneme, başarı şartı yok), *konu sınavı* (her konunun sonunda, isteğe bağlı) ve *eğitim sonu sınavı* (md. 16/2).
- **Geçme notu 100 üzerinden 60;** ilk sınavdan sonra en fazla 2 hak daha (toplam 3 deneme, md. 16/3). Hakkı dolan katılımcının temel eğitime yeniden katılması gerekir; yönetici "Sınavlar" sayfasından **Hak tanı** ile yeni hak verir (eski denemeler silinmez).
- **Açılma sırası:** Konu sınavı, konu tamamlanınca açılır. Eğitim sonu sınavı, tüm konular ve konu sınavları geçilince açılır.
- **Sorular:** Eğitim sayfasında konu satırındaki "Sınav" düğmesi ve "Eğitim sınavları" kartı. 2-5 seçenekli, tek doğru cevaplı. Her denemede soru ve seçenek sırası karışır; doğru cevap tarayıcıya gönderilmez.
- **Kayıt:** Her denemenin soruları, seçenekleri, verilen cevaplar, puan ve zamanları saklanır. Sınava giren katılımcı olan sınavın soruları değiştirilemez/silinemez (pasife alınabilir); sınav, konu ve eğitim silinemez.
- **Sınavlar** menüsü: tüm denemeler, cevap ayrıntısı, CSV indirme.

## Aşama 4 — Katılım belgesi (PDF) (Yönetmelik md. 17)
- Katılımcı; tüm konuları tamamlayıp (konu ve eğitim sonu) sınavları geçince eğitim sayfasında **"Katılım belgesini indir (PDF)"** düğmesini görür.
- 1. sayfa örnek belgenin (Ek-2) tasarımıdır; 2. sayfada eğitim konuları ve süreleri yer alır. Belge numarası: `KRM-YIL-000001`.
- Tarihler, katılımcının eğitime girdiği gerçek günlerdir (2 günde bitirirse iki tarih yazılır).
- Belge düzenlendiği anda dondurulur; sonradan eğitim/firma adı değişse de belge aynı kalır.
- Yönetici: Eğitim sayfasında **Belge bilgileri** (süre, şekil, eğiticiler), Firmalar'da **işveren adları**, Atamalar'da **ilk/tekrar** türü, **Belgeler** sayfasında tüm belgeler ve **OSGB unvanı**.
- Yazı tipleri (OFL lisanslı Carlito, Liberation Serif, Poppins) `tools/fonts` içindedir; değiştirirseniz `node tools/build-fonts.mjs` ile `public/pdf/fonts` yeniden üretilir.

## KVKK aydınlatma metni onayı
- Katılımcı ilk girişte, eğitim verilerine ulaşmadan önce **Aydınlatma Metni**'ni görür; kutuyu işaretleyip "Onaylıyorum ve devam ediyorum" demeden eğitime geçemez (sunucu tarafında da engellenir).
- Kayıt: kullanıcı, metin sürümü, metnin SHA-256 özeti, tarih-saat, IP ve tarayıcı bilgisi. Etkinlik günlüğüne de "Aydınlatma metnini onayladı" düşer.
- Yönetici: Katılımcılar → **Aydınlatma onayları** (kimin onayladığı/beklediği, CSV indirme).
- Metin `src/consent_text.js` içindedir. Metni değiştirirseniz `CONSENT_VERSION` değerini artırın (v2…); herkesten yeniden onay istenir.

## Cloudflare'e yükleme (Workers Builds ile GitHub'dan)

1. Bu klasörü bir GitHub deposuna yükleyin.
2. Cloudflare paneli → **Workers & Pages → Create → Import a repository** ile depoyu seçin.
   Proje adı `karma-egitim` kalsın. Build komutu boş, deploy komutu `npx wrangler deploy` olsun.
3. Yükleme bitince projenin **Settings → Variables and Secrets** bölümüne gidin ve
   **`SETUP_CODE`** adında bir **Secret** ekleyin. Değer olarak en az 8 karakterlik, tahmin edilmesi zor
   bir kod yazın (bunu yalnızca ilk yönetici hesabını açarken kullanacaksınız).
4. Sitenin adresini açın (`karma-egitim.<hesabınız>.workers.dev`). "İlk kurulum" ekranında
   kurulum kodunu ve yönetici bilgilerinizi girin. Kurulum bir kez yapılabilir; sonrasında bu ekran kapanır.

## Sorun giderme

- **Yükleme "D1" / "database_id" hatası verirse:** Cloudflare panelinde **Storage & Databases → D1 → Create database**
  ile `karma-egitim-db` adında veritabanı oluşturun, açılan sayfadaki **Database ID** değerini kopyalayın ve
  `wrangler.jsonc` içindeki `"database_name"` satırının altına `"database_id": "KOPYALADIĞINIZ-ID"` olarak ekleyin.
- **Kurulum ekranı "SETUP_CODE tanımlanmamış" derse:** 3. adımdaki Secret eklenmemiş veya 8 karakterden kısadır.

## Yerel test (geliştiriciler için)

```
npm test                             # API testleri (Aşama 1 + 2)
node test/devserver.mjs              # yerel deneme sunucusu (http://localhost:8787, bellek içi D1 + R2)
node test/e2e.mjs                    # Aşama 1 tarayıcı testi (Playwright gerekir)
PORT=8788 node test/devserver.mjs & VIDEO=/yol/test.webm node test/e2e-stage2.mjs   # Aşama 2 tarayıcı testi (WebM video, ≥ 30 sn)
node test/e2e-stage3.mjs             # Aşama 3 tarayıcı testi (aynı sunucu, boş veritabanıyla)
```

Node 22+ gerekir. Test sunucusunun kurulum kodu: `deneme-kodu-123` (yalnızca yerelde geçerlidir).
