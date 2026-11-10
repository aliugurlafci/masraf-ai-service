# Masraf mobil uygulaması

Çalışanların fiş veya fatura fotoğrafı çekip masraf formu oluşturduğu, onaycıların gelen formları onaylayıp reddettiği React Native + Expo uygulaması. Uygulama yalnızca `docs/onay-sistemi.md` içindeki API sözleşmesiyle konuşur (bölüm 5–6).

- Expo SDK 58, React Native 0.88, React 19.3
- `expo-router` (dosya tabanlı yönlendirme), TypeScript strict
- `react-native-reanimated` 4 ve `react-native-gesture-handler` 3 (animasyon ve hareketler UI iş parçacığında)
- `@tanstack/react-query` (önbellek, yeniden deneme, uygulama öne gelince yenileme, sayfalı liste)

## Kurulum

Node 24 ve npm 11 gerekir.

```bash
cd masraf-app
npm install
```

### Ayarlar (`.env`)

Ayarlar `masraf-app/.env` dosyasından okunur. Şablon `env.example` dosyasıdır; her değişken orada açıklanmıştır.

```bash
# Windows (cmd veya PowerShell)
copy env.example .env
# macOS / Linux / Git Bash
cp env.example .env
```

| Değişken | Varsayılan | Açıklama |
|---|---|---|
| `EXPO_PUBLIC_API_URL` | (zorunlu) | Sunucunun adresi: simülatör ve `adb reverse` için `http://127.0.0.1:4000`, iPhone/Wi-Fi için bilgisayarın Wi-Fi adresi (örn. `http://192.168.1.20:4000`, aşağıya bakın). Tanımlı değilse uygulama açılışta uyarı ekranı gösterir. |
| `EXPO_PUBLIC_OKUMA_SORGU_ARALIGI_MS` | `2500` | Fatura okunurken durumun kaç ms'de bir sorulacağı. Arka planda okunan faturası olan kayıtlı form en az 3 sn arayla sorulur. |
| `EXPO_PUBLIC_OKUMA_UST_SURE_MS` | `300000` | Okuma için en uzun bekleme. Süre dolunca form elle doldurulur. |
| `EXPO_PUBLIC_ISTEK_ZAMAN_ASIMI_MS` | `20000` | Bir API isteğinin zaman aşımı. |
| `EXPO_PUBLIC_YUKLEME_ZAMAN_ASIMI_MS` | `60000` | Fatura dosyası yükleme isteğinin zaman aşımı. |

`EXPO_PUBLIC_*` değerleri uygulama paketine gömülür; buraya gizli bilgi yazmayın. `.env` değişince Metro'yu önbelleği temizleyerek yeniden başlatın: `npx expo start -c`.

## Çalıştırma

```bash
npx expo start
```

Ardından terminalde `a` (Android) veya `i` (iOS simülatörü) tuşuna basın ya da Expo Go ile QR kodu okutun. Kullanılan bütün modüller Expo Go'da bulunur; ayrı bir geliştirme derlemesi gerekmez.

Telefonda `127.0.0.1` telefonun kendisidir; bilgisayardaki sunucuya ulaşmaz. Cihaza göre aşağıdaki yollardan birini kullanın.

### iPhone ya da Wi-Fi'deki telefon

Sunucu varsayılan olarak yalnızca bilgisayarın kendisine açıktır. Gerçek bir iPhone'un (ya da kablosuz bağlı bir Android'in) ulaşabilmesi için sunucuyu aynı Wi-Fi'ye açın:

1. Kök dizindeki `.env` dosyasına `AG_ERISIMI=yerel` ekleyin ve sunucuyu yeniden başlatın. Açılışta konsolda `Yerel ağdan: http://192.168.x.x:4000` gibi bir satır çıkar.
2. `masraf-app/.env` içinde `EXPO_PUBLIC_API_URL` değerini o adres yapın (Wi-Fi bağdaştırıcısının adresi; `vEthernet` adresleri WSL/Hyper-V içindir) ve Metro'yu `npx expo start -c` ile yeniden başlatın.
3. Telefon bilgisayarla aynı Wi-Fi'de olmalı. iPhone'da Expo Go "yerel ağdaki aygıtları bulma" izni isterse verin (Ayarlar → Gizlilik ve Güvenlik → Yerel Ağ → Expo Go).
4. Uygulamadan önce telefonun tarayıcısında `http://<adres>:4000/health` açın; `{"durum":"ok"}` görünmüyorsa sorun uygulamada değil ağdadır. Misafir ve şirket Wi-Fi'leri cihazların birbirine bağlanmasını çoğu zaman engeller (istemci yalıtımı), bilgisayardaki güvenlik duvarı da gelen bağlantıyı kesebilir. O durumda bilgisayarı telefonun kişisel erişim noktasına bağlayıp sunucunun yazdığı yeni adresi kullanın.

Sunucu yalnızca özel ağ adreslerinden (192.168.x.x, 10.x.x.x, 172.16–31.x.x) gelen istekleri kabul eder. Bağlantı şifresiz HTTP olduğundan aynı ağdaki biri oturumları ve faturaları görebilir; yalnızca güvendiğiniz ağlarda açın. Bilgisayarın Wi-Fi adresi değişirse `EXPO_PUBLIC_API_URL` değerini de güncelleyin.

### Android: `adb reverse`

Emülatör veya USB ile bağlı cihaz, sunucuyu ağa açmadan kendi `127.0.0.1:4000` adresini bilgisayara şu komutla yönlendirir:

```bash
adb reverse tcp:4000 tcp:4000
```

Komutu her cihaz bağlantısında (emülatör yeniden başlayınca da) tekrarlayın. Sunucu başka bir portta çalışıyorsa iki port numarasını ve `EXPO_PUBLIC_API_URL` değerini birlikte değiştirin. `adb` PATH'te değilse Android SDK'daki tam yolu kullanın (Windows: `%LOCALAPPDATA%\Android\Sdk\platform-tools\adb.exe`).

Ardından uygulamayı `npm run android` ile açın. Bu komut Metro'yu `--localhost` ile başlatır: uygulama Metro'ya da `127.0.0.1` üzerinden bağlanır, Expo Metro portu için `adb reverse` kuralını kendisi ekler, bilgisayarın Wi-Fi'sine gerek kalmaz. Metro'nun portu (8081) başka bir programda açıksa Expo başka bir port önerir; kabul edin ya da portu kendiniz verin: `npx expo start --android --localhost --port 8082`.

### iOS simülatörü

Simülatör bilgisayarın ağını paylaşır; `http://127.0.0.1:4000` doğrudan sunucuya ulaşır, ek ayar gerekmez. Gerçek iPhone için yukarıdaki "iPhone ya da Wi-Fi'deki telefon" adımlarını izleyin.

## Doğrulama

```bash
npx tsc --noEmit                 # tip denetimi (npm run typecheck)
npx expo-doctor                  # bağımlılık ve yapılandırma denetimi
npx expo export --platform android --output-dir <repo dışı bir klasör>   # paketleme denemesi
```

## Ekranlar

| Yol | Ekran |
|---|---|
| `src/app/giris.tsx` | Giriş (`POST /api/oturum`, `istemci: "mobil"`) |
| `src/app/sifre.tsx` | Şifre değiştir (`PUT /api/ben/sifre`). `sifreDegismeli` ise girişten sonra zorunlu |
| `src/app/(tabs)/index.tsx` | Ana sayfa (`GET /api/ozet`): bu ay toplamı, durum sayaçları, bekleyen onaylar, son masraflar, şirket geneli |
| `src/app/(tabs)/masraflar.tsx` | Masraflarım (`GET /api/masraflar`): arama, durum çipleri, sonsuz kaydırma, Benim/Tümü; okunan/okunamayan fatura rozeti, tutarı henüz olmayan taslak |
| `src/app/masraf/yeni.tsx` | Yeni masraf: kamera, galeri, PDF veya faturasız giriş; okuma (sıradaki yer ve önündeki fatura sayısıyla), form, onay rotası önizlemesi. Okumalar bitmeden taslak kaydedilebilir (`bekleyenFaturalar`, tutar boş kalabilir, isteğe bağlı "Okumalar bitince onaya gönder"). Masraf merkezi (kullanıcıya tanımlı aktif olanlar, tek ise seçili gelir) ve her fişin altında açılır "Fiş bilgileri" (liste alanları sunucuda aranan alt sayfadan seçilir; metin, sayı, tarih). Fiş alanları okuma bitmeden de doldurulur, dosya faturaya dönüşünce değerler onunla kalır (`fisAlanlari`) |
| `src/app/(tabs)/onaylar.tsx` | Onaylar (`GET /api/onaylar`): Bekleyen ve Karar verdiklerim |
| `src/app/(tabs)/profil.tsx` | Profil: kullanıcı, rol, onaycılık, şifre, tema, sunucu adresi, çıkış |
| `src/app/masraf/[id]/index.tsx` | Masraf detayı: organizasyon ve masraf merkezi, fatura, her faturanın ve okunmayı bekleyen dosyanın fiş bilgileri ile eksik zorunlu alanları, okunmayı bekleyen faturalar (sıra, yeniden oku, çıkar; bekleyen varken birkaç saniyede bir yenilenir), okununca gönder anahtarı, onay zaman çizelgesi, geçmiş, `izinler`e göre eylemler |
| `src/app/masraf/[id]/duzenle.tsx` | Düzenleme (aynı form, `PATCH`); arka planda okunan faturalar okununca forma normal fatura olarak eklenir |
| `src/app/fatura/[id].tsx` | Fatura görseli tam ekran (yakınlaştırma, kaydırma, çift dokunma) |

## Klasör yapısı

```
src/
  app/          expo-router ekranları (dosya = rota)
  api/          tek API istemcisi: tipler (sözleşmeden), istek/hata/zaman aşımı, uçlar, React Query kancaları
  auth/         oturum: token yalnızca expo-secure-store'da, 401'de girişe dönüş
  components/   ui/ (tasarım sistemi bileşenleri), expense/ (masraf parçaları), form/ (masraf formu)
  hooks/        hareket ayarı, debounce, fatura okuma (yükle + sor)
  lib/          biçimlendirme (tr-TR para ve tarih), durum etiketleri, kategori simgeleri, dosya seçiciler, haptik
  theme/        renk, boşluk, tipografi, köşe yarıçapı token'ları; açık/koyu tema
  config.ts     bütün ayarlar (EXPO_PUBLIC_*)
```

## Notlar

- Oturum token'ı yalnızca `expo-secure-store` içinde tutulur ve istekler `Authorization: Bearer` başlığı taşır. Sunucu `401` dönerse oturum kapanır ve giriş ekranı açılır.
- Düğmeler sunucunun döndürdüğü `izinler` alanına göre gösterilir; uygulama iş kurallarını kendisi hesaplamaz. Onay rotası da sunucudan (`POST /api/onay-akisi/onizle`) gelir.
- Zorunlu alan yıldızları ve "eksik" uyarıları `src/lib/fields.ts` ile hesaplanır (sunucudaki `requiredFields`'ın aynısı, `GET /api/alanlar`); kararı sunucu verir (`eksikAlanlar`, `409 alan_eksik` / `fatura_eksik`). Alan, liste ve Excel yönetimi yalnızca web panelindedir.
- Tema tercihi (sistem/açık/koyu) cihazda saklanır.
- Animasyonlar sistemdeki "hareketi azalt" ayarı açıksa kapanır.
- Yayın (release) Android derlemesi düz `http://` adresine varsayılan olarak izin vermez. Geliştirme ve Expo Go'da sorun yoktur; yayın derlemesi gerekirse `expo-build-properties` ile `usesCleartextTraffic` açılmalıdır.
