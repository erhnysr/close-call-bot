# Close Call bot

Kendi DID'lerini Close Call yarışmasına kaydeder ve onları ikişer eşleyip LONG/SHORT çiftleri açar. İmza metinleri resmi kurallarla (flop-labs/technocore-close-call-challenge) ve UfukNode/technocore-close-call-desk ile birebir aynıdır.

Gereken tek şey Node.js 20+. Kurulacak paket yok.

## Kullanım

```bash
cd close-call-bot
cp ~/Desktop/"FLOP PRİVATE KEY"/<ana-key-dosyan>.json keys/main.json   # ana DID de çiftlere girsin
node close-call-bot.mjs keys 9        # 9 yeni DID (ana DID ile 10 → 5 çift)
node close-call-bot.mjs register      # yenileri yarışmaya kaydeder
# ~5-10 dk bekle
node close-call-bot.mjs status        # hepsi "kayıt ONAYLI" olmalı
caffeinate -i node close-call-bot.mjs auto   # otomatik mod, terminal açık kalsın
```

## Strateji (auto modu)

Skor her DID için ayrı: kapanış fiyatına göre PnL eksi fee. Bir çiftte LONG ve SHORT kendi DID'lerin olduğu için fiyat hangi yöne giderse gitsin çiftin bir tarafı artıda biter; o tarafın skoru kabaca `miktar × |kapanış − giriş| − fee`.

Bu yüzden iki şey önemli:

1. **Miktar maksimum:** her çift bakiyenin %98'iyle açılır (~43 NVDA).
2. **Girişler yayılmış:** aynı fiyattan açılan çiftler aynı skoru verir. auto modu boştaki bir çifti ancak fiyat önceki tüm girişlerden `--step` dolar yukarı (yeni tepe) ya da aşağı (yeni dip) gittiğinde, veya `--hours` saattir giriş olmadıysa açar. Böylece girişler görülen fiyat aralığının uçlarına dağılır; kapanış nereye düşerse düşsün ondan en uzak giriş en yüksek skoru verir.

Bir işlem sonuçlanmazsa (süre geçer, görünmez) çift boşa düşer ve bir sonraki fırsatta tekrar açılır. Bot kapanırsa aynı komutla yeniden başlat; durum `bot-state.json`'da saklı.

## Notlar

- `main` ile başlayan key dosyaları zaten kayıtlı sayılır, tekrar kaydedilmez.
- Çiftler dosya sırasına göre kurulur: (1,2), (3,4)… Her çiftte ilk key LONG, ikincisi SHORT.
- Elle açmak için: `node close-call-bot.mjs pair --only 2`.
- İşlem kilidi: 4 Ekim 2026 09:00 UTC (TR 12:00). Kapanış fiyatı 10:00 UTC'den önceki son işlem.
- `keys/` kimseyle paylaşılmaz, repoya konmaz, bir AI'a verilmez. GitHub Actions'ta key'ler sadece şifreli `CLOSE_CALL_KEYS` secret'ında durur.
- GitHub Actions modu: `.github/workflows/close-call.yml` 10 dakikada bir `tick` çalıştırır ve `bot-state.json`'u repoya geri kaydeder. Bildirimler Telegram'a gider (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` secret'ları).
