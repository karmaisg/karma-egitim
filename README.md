# KARMA OSGB Eğitim Platformu

İş sağlığı ve güvenliği eğitimlerini online vermek için web tabanlı eğitim yönetim sistemi.
Cloudflare üzerinde çalışır (Workers + D1 veritabanı). Şifreler asla düz metin saklanmaz.

## Aşama 1 — şu an hazır olanlar

- Yönetici paneli: firmalar (tehlike sınıfı ile), katılımcılar, eğitimler, atamalar
- Eğitim → bölüm → konu yapısı (sıralanabilir)
- Katılımcı girişi (kullanıcı adı + şifre); yalnızca kendine atanan eğitimleri görür
- Şifre otomatik oluşturma ve sıfırlama; yanlış şifre denemesinde geçici kilit (5 deneme → 15 dk)

Sonraki aşamalar: video oynatıcı ve katılım kayıtları (Yön. md. 12/4, 12/5), sınavlar (md. 16/2), PDF katılım belgesi (md. 17).

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
node --test test/api.test.mjs        # API testleri
node test/devserver.mjs              # yerel deneme sunucusu (http://localhost:8787)
node test/e2e.mjs                    # tarayıcı testi (Playwright gerekir)
```

Node 22+ gerekir. Test sunucusunun kurulum kodu: `deneme-kodu-123` (yalnızca yerelde geçerlidir).
