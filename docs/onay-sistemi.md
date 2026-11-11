# Masraf formları ve onay sistemi: tasarım ve API sözleşmesi

Bu belge web paneli, mobil uygulama (`masraf-app/`) ve sunucu için tek kaynaktır. Sözleşme değişirse önce bu belge güncellenir.

## 1. Kavramlar

| Kavram | Açıklama |
|---|---|
| Kullanıcı | E-posta ve şifreyle giriş yapar. Rolü `calisan`, `muhasebe` ya da `yonetici`dir. |
| Fatura kaydı | Claude'un okuduğu fatura (`{fatura, kalemler}`), orijinal dosyasıyla birlikte veritabanında saklanır. Aynı dosya (SHA-256) ikinci kez okunmaz. |
| Masraf formu | Çalışanın onaya sunduğu masraf. Bir başlık, kategori, tarih, tutar ve isteğe bağlı olarak bir ya da birden çok (en çok 20) fatura kaydından oluşur. Örneğin bir iş seyahatinin otel, taksi ve yemek fişleri tek formda toplanabilir. |
| Bekleyen fatura | Forma eklenmiş ama henüz okunmamış (ya da okunamamış) fatura dosyası. Sunucu dosyayı veritabanında saklar ve arka planda okur. Okununca fatura kaydı olarak forma eklenir (bölüm 3, "Arka planda okuma"). |
| Okuma sırası | Claude'u bekleyen dosyaların sırası. Panel, mobil ve API'den gelen bütün okumalar aynı sırayı paylaşır. Bekleyen her dosya için sıradaki yeri (`kuyrukSirasi`) ve kendisinden önce okunacak dosya sayısı (`onundeki`) gösterilir. |
| Onay akışı | Adı olan, sıralı bir onaycı listesi. Her onaycının bir onay limiti vardır; akışın stratejisi (zincirleme onay ya da tek onaycı) masrafı kimlerin onaylayacağını belirler. Şirkette birden çok akış olabilir, biri varsayılandır. |
| Akış ataması | Kullanıcının masraflarının hangi akışla onaylanacağı. Atanmamış kullanıcı varsayılan akışı kullanır. |
| Onay adımı | Gönderilen bir formun, gönderenin akışından kopyalanan onaycılarından biri. |
| Organizasyon | Şirket. Yönetici her kullanıcıya en çok bir organizasyon tanımlar; form sahibinin organizasyonunu taşır. |
| Masraf merkezi | Yönetici kullanıcıya bir ya da birden çok masraf merkezi tanımlar. Gönderen formda bunlardan birini seçer. |
| Tanım listeleri | Organizasyonlar, masraf merkezleri, kategoriler ve liste türündeki fiş alanlarının seçenekleri (ör. etiketler, proje kodları). Yönetici panelden yönetir, Excel ile içe ve dışa aktarır. |
| Fiş alanı | Formdaki her fatura (fiş) için ayrı doldurulan alan: etiket, proje kodu, ödeme yöntemi, not gibi. Hangi alanların olduğu ve hangilerinin zorunlu olduğu "Alan yönetimi"nden ayarlanır (bölüm 3, "Fiş alanları"). |
| Zorunluluk kuralı | "Kategori şuysa (ya da bir fiş alanı şu değerdeyse) şu alanlar zorunludur" biçiminde koşullu zorunluluk. |

### Roller

| Yetki | calisan | muhasebe | yonetici |
|---|:-:|:-:|:-:|
| Fatura okutma, kendi masraf formları | ✓ | ✓ | ✓ |
| Kendisine gelen onaylar (akışta yer alıyorsa) | ✓ | ✓ | ✓ |
| Tüm formları görme, CSV dışa aktarma, "ödendi" işaretleme | | ✓ | ✓ |
| Tüm faturaları ve canlı izlemenin tamamını görme | | ✓ | ✓ |
| Kullanıcı, kategori ve onay akışı yönetimi, akış ataması, onay devretme | | | ✓ |
| Tanım listeleri (organizasyon, masraf merkezi, kategori, seçenekler), Excel içe/dışa aktarma, alan yönetimi ve zorunluluk kuralları | | | ✓ |
| Entegrasyonlar (SAP PI/PO'ya gönderim, bölüm 9) ve gönderim kaydı | | | ✓ |

Onaycılık bir rol değildir. Her rolden aktif kullanıcı bir ya da birden çok onay akışına eklenebilir.

## 2. Onay akışları

Şirkette birden çok onay akışı tanımlanabilir. Böylece her kullanıcının masrafı farklı onaycılara ve farklı tutar aralıklarına göre yönlenebilir. Örneğin satış ekibi "Satış" akışına, yönetim kadrosu "Yönetim" akışına atanır, diğer herkes varsayılan akışı kullanır.

- **Varsayılan akış:** Her zaman tam bir akış varsayılandır. İlk kurulumda "Genel" adıyla oluşur. Varsayılan akış silinemez. Başka bir akış varsayılan yapıldığında eski varsayılan sıradan bir akışa döner.
- **Atama:** Yönetici kullanıcıyı bir akışa atar (`onayAkisiId`). `null` olan kullanıcı varsayılan akışı kullanır ve varsayılan değişirse yenisini izler. Bir akışa açıkça atanmış kullanıcı, o akış varsayılan olmaktan çıksa da onda kalır.
- **Akış adı** 1–80 karakterdir ve benzersizdir (büyük/küçük harf ayrımı yapılmaz).
- **Silme:** Varsayılan olmayan akış silinebilir. Ona atanmış kullanıcılar varsayılan akışa geçer (`onayAkisiId: null`). Süren formlar etkilenmez (kural 9).

Her onay akışı sıralı bir onaycı listesidir. Her onaycının bir **onay limiti** vardır: son onayını verebileceği en yüksek tutar (dahil). Limitler sırayla büyür; son onaycının limiti sınırsızdır. Böylece her tutar için limiti o tutara yeten tam bir onaycı bulunur: **karar veren onaycı**. Akışın **stratejisi**, masrafı karar verenden başka kimin göreceğini belirler:

- **Zincirleme onay (`zincir`):** Masraf ilk onaycıdan başlar ve karar veren onaycıya kadar sıradaki herkesin onayından geçer. Tutar büyüdükçe zincir uzar.
- **Tek onaycı (`tek`):** Masrafı yalnızca karar veren onaycı onaylar. Her tutar aralığının kendi onaycısı vardır.

| Sıra | Onaycı | Onay limiti | Zincirleme onayda | Tek onaycıda |
|---|---|---|---|---|
| 1 | Ayşe (birim) | 5.000,00 | 5.000'e kadar: Ayşe | 5.000'e kadar: Ayşe |
| 2 | Mehmet (finans) | 50.000,00 | 5.000,01 – 50.000: Ayşe → Mehmet | 5.000,01 – 50.000: Mehmet |
| 3 | Zeynep (GM) | sınırsız | 50.000 üzeri: Ayşe → Mehmet → Zeynep | 50.000 üzeri: Zeynep |

Kurallar:

1. **En az bir onaycı zorunludur.** Hiçbir akış boş kalamaz. İlk yönetici oluşturulurken varsayılan akış o yöneticiyle (limiti sınırsız) başlar. Yeni akışın stratejisi belirtilir; ilk kurulumdaki "Genel" akışı zincirleme onaydır.
2. **Onay limiti:** Kuruş hassasiyetindedir ve dahildir: limiti 5.000 olan onaycı tam 5.000'lik masrafın da son onayını verir, 5.000,01 bir sonrakine geçer. Son onaycı dışındaki her onaycının limiti 0'dan büyüktür ve bir öncekinden büyük olmalıdır. Son onaycının limiti sınırsızdır (`limit: null`). Bu kurallar her tutarın tam bir karar veren onaycısı olmasını sağlar; aralık boşluğu ya da çakışması oluşamaz. Kurala uymayan akış kaydedilmez (`400 gecersiz_akis`, sorunlar Türkçe listelenir).
3. **Sıra = yetki sırası.** Onaycılar küçük limitten büyüğe dizilir. Zincirleme onayda masraf bu sırayla ilerler.
4. **Bir kullanıcı bir akışta bir kez** yer alır, farklı akışlarda ayrı limitlerle yer alabilir. Onaycı aktif olmalıdır.
5. **Yönlendirme:** Form, **gönderenin akışına** (atanmış akış, yoksa varsayılan akış) göre yönlenir: karar veren onaycı onay tutarına göre bulunur, stratejiye göre ondan önceki onaycılar da eklenir ve hepsi **sırayla** onaylar. Hangi akışın kullanıldığı gönderim anında belirlenir ve form geçmişine yazılır. Örnekte zincirleme onayda 3.000 ₺ yalnızca Ayşe'ye, 20.000 ₺ önce Ayşe'ye sonra Mehmet'e, 80.000 ₺ üçüne de gider; tek onaycıda 20.000 ₺ yalnızca Mehmet'e gider.
6. **Onay tutarı:** Formun yerel para birimindeki (`PARA_BIRIMI`) tutarı ile bağlı faturaların yerel para birimindeki toplamından büyük olanıdır. Her faturanın yerel değeri şöyle bulunur:
   - Formla aynı para birimindeki (ya da para birimi okunamamış) fatura: genel toplamı × formun kuru.
   - Yerel para birimindeki fatura: genel toplamının kendisi.
   - Başka bir para birimindeki fatura: gönderenin girdiği yerel karşılık (`yerelKarsilik`). Karşılığı girilmemiş böyle bir fatura varken form onaya gönderilemez (`409 karsilik_eksik`); taslak olarak kaydedilebilir.

   Toplama genel toplamı (ya da karşılığı) sıfırdan büyük olan faturalar girer. Faturaların altında beyan edilen bir form daha düşük bir onay kademesine kaçamaz. İki tutar farklıysa onaycılar bunu formda uyarı olarak görür (`tutarFarki`).
7. **Para birimi:** Onay limitleri `.env` içindeki `PARA_BIRIMI` (varsayılan `TRY`) cinsindendir. Başka para birimindeki formda kur zorunludur. Yerel tutar, tutar × kur olarak hesaplanır.
8. **Kendi masrafı:** Kimse kendi masrafını onaylamaz. Gönderen, masrafın geçtiği onaycılardan biriyse onun adımı `atlandi` olur. Gönderen karar veren onaycıysa son onay **bir üst onaycıya** geçer (akışta ondan sonraki onaycı). Gönderen akışın en üstündeyse son onay, gönderen dışındaki ve bu masrafı zaten onaylamayan ilk aktif yöneticiye (`yedek: true`) gider; kimse aynı masrafı iki kez onaylamaz. Böyle biri de yoksa ve masrafı onaylayacak başka kimse kalmadıysa gönderim `409 onaylayan_yok` ile reddedilir. Örnekte Mehmet'in 20.000 ₺'lik masrafı zincirleme onayda Ayşe'ye, sonra Zeynep'e gider.
9. **Anlık kopya:** Form gönderildiğinde eşleşen adımlar forma kopyalanır. Akış, akışın varsayılanlığı ya da kullanıcının ataması sonradan değişse de süren formlar etkilenmez.
10. **Herhangi bir akışta onaycı olan kullanıcı pasifleştirilemez.** Önce o akışlardan çıkarılmalıdır. Bekleyen onayı olan kullanıcı da pasifleştirilemez; yönetici önce onayları devreder. Pasif kullanıcının akış ataması korunur.

## 3. Formun yaşam döngüsü

```
taslak ──gönder──▶ onayda ──son adım onay──▶ onaylandi ──ödendi──▶ odendi
  ▲  │               │ │
  │  └──iptal──▶ iptal │ └──bir adım ret──▶ reddedildi ──düzenle + gönder──▶ onayda (yeni tur)
  └────geri çek───────┘                        └──iptal──▶ iptal
```

| İşlem | Kim | Hangi durumda | Sonuç |
|---|---|---|---|
| Düzenle | sahibi | `taslak`, `reddedildi` | Alanlar güncellenir, durum değişmez |
| Gönder | sahibi | `taslak`, `reddedildi` | `tur` bir artar, adımlar sahibinin akışından kopyalanır, ilk adım `bekliyor` olur, form `onayda` olur. Bekleyen faturası olan form gönderilemez |
| Yeniden oku | sahibi | `taslak`, `reddedildi` | Okunamayan bekleyen faturalar yeniden okuma sırasına girer |
| Geri çek | sahibi | `onayda` | Kalan adımlar `iptal`, form `taslak` |
| İptal | sahibi | `taslak`, `reddedildi` | Form `iptal`. Bağlı faturalar başka formda kullanılabilir hale gelir. Bekleyen faturalar formdan silinir (okunmaları sürer, okununca kullanıcının fatura listesine düşer) |
| Onayla | sıradaki onaycı | `onayda` | Adım `onaylandi`. Sıradaki adım `bekliyor` olur. Adım kalmadıysa form `onaylandi` |
| Reddet | sıradaki onaycı | `onayda` | Açıklama zorunlu. Adım `reddedildi`, kalan adımlar `iptal`, form `reddedildi` |
| Ödendi | muhasebe, yonetici | `onaylandi` | Form `odendi` |
| Devret | yonetici | `onayda` | Karar verilmemiş bir adımın onaycısı değişir |

Adım durumları: `sirada` (henüz sırası gelmedi) → `bekliyor` (karar bekliyor, yalnızca bir tane) → `onaylandi` / `reddedildi`. Ayrıca `atlandi` (kendi masrafı) ve `iptal` (geri çekildi veya reddedildi).

Ek kurallar:

- Bir forma en çok 20 fatura eklenir ve aynı fatura bir forma iki kez eklenemez. Faturaların sırası eklenme sırasıdır.
- Bir fatura kaydı, iptal edilmemiş en fazla bir formda kullanılabilir (çift beyan koruması). Veritabanında filtreli benzersiz indeksle korunur. İptal edilen formun fatura bağları kayıtta kalır ama faturalar serbest kalır.
- Aynı adım için iki karar aynı anda gelirse yalnızca biri geçer, diğeri `409 onay_beklemiyor` alır.
- Her işlem form geçmişine (`gecmis`) yazılır. Yönetici işlemleri (kullanıcı, akış, kategori) denetim kaydına yazılır.

### Fatura bilgileri, düzeltme ve gönderim kontrolleri

- Okunan fatura kaydı (`fatura_kayitlari.sonuc`) hiç değişmez: aynı dosyayı yükleyen herkes aynı kaydı paylaşır. Kullanıcının düzeltmesi faturanın formdaki bağına (`form_faturalari.duzeltme`) yazılır ve yalnızca o formu etkiler.
- Formdaki bir faturanın **geçerli bilgisi** düzeltme varsa düzeltme, yoksa okunan sonuçtur. Formla ilgili her hesap (yerel tutar, onay tutarı, `tutarFarki`, karşılık gereksinimi, eksik alan, mükerrer kontrolü, PDF, listelerdeki özet alanlar) geçerli bilgiyle yapılır.
- Düzeltme, faturanın JSON şemasının tamamıdır (`{ fatura: {10 alan}, kalemler: [...] }`, `src/invoice/schema.ts`). Okunan sonuçla aynı olan düzeltme saklanmaz (düzeltme yok sayılır).
- Düzeltmeyi yalnızca formu düzenleyebilen kişi yapar (sahibi, `taslak` ya da `reddedildi`). Formdan çıkarılan faturanın düzeltmesi silinir; fatura yeniden eklenirse okunan sonuçla başlar.
- **Düzeltme izi:** Her düzeltme form geçmişine `guncellendi` olarak, değişen alanların adlarıyla yazılır: "2. fatura düzeltildi: fatura no, genel toplam." ya da "2. faturanın düzeltmesi geri alındı." Formu görebilen herkes yanıtta okunan değerleri (`okunan`) de görür.
- **Zorunlu alanlar:** Her faturanın geçerli bilgisinde, alan yönetiminde zorunlu yapılmış (ya da bir kuralla zorunlu olan) fatura bilgileri dolu olmalıdır. Başlangıçta bunlar `faturaNo`, `faturaTarihi`, `saticiUnvan` ve `genelToplam`'dır. Eksik alanlar yanıtta `eksikAlanlar` ile döner. Taslak kaydetmek serbesttir; gönderim `409 fatura_eksik` döner. Okuma kalitesi kontrolü (`src/invoice/checks.ts`, ucuz modelin okuması yetmezse sonraki modele geçme) bu ayardan etkilenmez, her zaman bu dört alana bakar.
- **Mükerrer fatura:** Gönderilen formdaki her faturanın anahtarı, aktif bağı olan (`form_faturalari.aktif = 1`) başka bir faturanın anahtarıyla aynıysa gönderim `409 fatura_mukerrer` döner. Aynı formdaki iki farklı faturanın anahtarı aynıysa da aynı hata döner. Anahtar geçerli bilgiden hesaplanır. Önce alanlar normalleştirilir: boşluk, `-`, `/` ve `.` silinir, ASCII kurallarıyla büyük harfe çevrilir. Satıcı vergi no varsa anahtar `V|<vergiNo>|<faturaNo>`, yoksa `T|<faturaNo>|<faturaTarihi>|<genelToplam, 2 ondalık>` olur. `faturaNo` boşsa anahtar yoktur (zaten `fatura_eksik`). Hata mesajı başka kullanıcının formunun numarasını vermez.
  - Normalleştirme yalnızca vergi no ile fatura no'ya uygulanır ("ASCII büyük harf" yalnızca a–z; Türkçe harfler olduğu gibi kalır). Tarih `YYYY-MM-DD`, toplam iki ondalıkla yazılır: `T|F1|2026-11-05|1800.00`.
  - Taslaklar da sayılır: aynı anahtarlı iki taslaktan hiçbiri, öteki iptal edilmeden ya da düzeltilmeden gönderilemez.
  - Aynı formda aynı anahtarlı iki fatura varsa `alanlar` içinde yalnızca sonraki fatura döner ("3. fatura, 1. faturayla aynı…").
  - Mükerrer fatura kullanıcının kendi formundaysa mesaj form numarasını verir (`fatura_kullaniliyor` ile aynı davranış).
- Düzeltmenin doğrulaması: metin alanları en çok 500 karakterdir, tarih takvimde var olan bir gün olmalıdır, para birimi büyük harfe çevrilir, bilinmeyen alan `400` döner. Önizleme listede olmayan faturaların düzeltmesini hata vermeden yok sayar.
- Gönderim kontrollerinin sırası: `okuma_suruyor`, `okuma_hatali`, `tutar_eksik`, `fatura_eksik`, `alan_eksik`, `fatura_mukerrer`, `karsilik_eksik`, `onaylayan_yok`. Liste değişikliği ve düzeltme notları tek bir `guncellendi` satırında birleşir ("1 fatura eklendi. 2. fatura düzeltildi: fatura tarihi.").

### Arka planda okuma ve "okununca gönder"

Sunucu yoğunken bir faturanın okunması dakikalar sürebilir. Kullanıcı okumayı beklemeden formu taslak olarak kaydedip çıkabilir; okumalar arka planda sürer.

- **Okuma sırası:** Claude'u bekleyen her dosya için `kuyrukSirasi` (Claude'u bekleyenler arasındaki yeri; 1 = sıradaki) ve `onundeki` (o dosyadan önce okunacak ya da şu an okunmakta olan dosya sayısı) gösterilir. Örneğin 2 dosya okunurken sırada üçüncü bekleyen dosyanın `kuyrukSirasi` 3, `onundeki` 4'tür. Sıra bütün kullanıcılar için ortaktır; çalışan başkalarının dosyalarını görmez, yalnızca kendi dosyasının yerini ve önündeki dosya sayısını görür. Okunmaya başlayan dosyada (`okunuyor`) ve sırasının yeri henüz belli olmayan dosyada iki alan da `null` olur.
- **Bekleyen fatura:** İstemci dosyayı `POST /api/invoices/toplu` ile yükler; yanıttaki her dosyada `dosyaOzeti` (SHA-256) bulunur. Okuması bitmemiş dosya, formu kaydederken `bekleyenFaturalar` listesinde bu özetle gönderilir. Sunucu dosyayı o anda okuma sırasından alır, veritabanına (`bekleyen_faturalar`) yazar ve okumayı izler. Sunucu yeniden başlarsa okunmamış bekleyen faturalar baştan okuma sırasına girer; son faturası okunduğu halde gönderimi yapılamadan duran "okununca gönder" formları da yeniden denenir. Belleği korumak için arka planda okunacak dosyalardan en çok `CLAUDE_MAX_CONCURRENT` tanesi birden veritabanından alınıp okuma sırasına girer; diğerleri `sirada` görünür, yerleri (`kuyrukSirasi`, `onundeki`) sıraya girene kadar `null` kalır. Sonucu veritabanına yazılamayan dosya (geçici veritabanı hatası) artan aralıklarla birkaç kez yeniden denenir; yine olmazsa `yeniden-oku` ya da yeniden başlatma onu sıraya geri koyar.
- **Okuma bitince:** Dosya okununca fatura kaydı formun fatura listesinin sonuna eklenir ve bekleyen faturalardan çıkar. Okuma başarısız olursa bekleyen fatura `hata` durumunda formda kalır; sahibi `POST /api/masraflar/:id/yeniden-oku` ile okunamayanların hepsini yeniden okutabilir (geçmişe "… yeniden okunuyor." yazılır) ya da bekleyen listeden çıkarabilir. Okunan fatura başka bir aktif formda kullanılıyorsa forma eklenmez, bekleyen fatura `hata` (`fatura_kullaniliyor`) olur. Aynı dosya formda zaten fatura olarak varsa bekleyen fatura sessizce silinir.
- **Boş alanların doldurulması:** Tutar taslakta boş (`null`) bırakılabilir. Formun bekleyen faturalarının hepsi okunup eklendiğinde (okunamayan kalmadıysa) ve okununca gönder denemesinden hemen önce sunucu, boş bırakılmış tutarı faturaların formun para birimindeki toplamıyla (6. kuraldaki hesap: formun para birimindeki ve para birimi okunamamış faturalar ile kurla çevrilen yerel para birimindeki faturalar; karşılık isteyen faturalar sayılmaz) ve boş satıcıyı ilk faturanın satıcısıyla doldurur. Kullanıcının girdiği değerlere dokunmaz. Toplama giren fatura yoksa tutar boş kalır. Okunamayan fatura varken doldurma yapılmaz; sahibi okunamayanı elle çıkarırsa (okununca gönder kapalıyken) boş tutarı kendisi girer. Başlık, kategori, masraf tarihi ve para birimi kaydederken zorunludur ve sunucu bunları değiştirmez.
- **Bilgilendirme:** Okumayı bekleyen son fatura da sonuçlandığında form sahibine bildirim (ve mail tercihi açıksa mail) gider: hepsi okunduysa `okuma_bitti`, okunamayan varsa `okuma_hatasi`. Form geçmişine sistem adına (`kullanici: null`) bir `guncellendi` satırı yazılır.
- **Okununca gönder (`okununcaGonder`):** Sahibi kaydederken bu seçeneği açabilir. Formda bekleyen fatura kalmadığında (hepsi okunup eklendiğinde ya da okunamayanlar çıkarıldığında) sunucu formu sahibi adına onaya göndermeyi dener; seçenek bu denemeyle kapanır. Gönderim başarılıysa sahibine `onaya_gonderildi`, onaycıya her zamanki `onay_bekliyor` bildirimi gider; geçmişteki `gonderildi` satırı "Faturalar okununca kendiliğinden gönderildi." diye başlar. Gönderim kontrollerinden biri tutmazsa (`tutar_eksik`, `fatura_eksik`, `alan_eksik`, `fatura_mukerrer`, `karsilik_eksik`, `onaylayan_yok`) form taslak kalır ve sahibine sebebiyle birlikte `onaya_gonderilemedi` gider. Okunamayan fatura varken gönderim denenmez (`okuma_hatasi` gider, seçenek açık kalır); okunamayan fatura yeniden okunup eklenince ya da formdan çıkarılınca deneme yapılır. Seçenek açık kaydedilen formda hiç bekleyen fatura yoksa deneme kaydın hemen ardından yapılır ve yanıt formun son durumunu gösterir. Deneme sahibinin kendi isteğinin ardından yapıldığında (kayıt ya da okunamayan faturayı çıkaran düzenleme) sahibine `onaya_gonderildi`/`onaya_gonderilemedi` gitmez; sonuç yanıtta ve geçmişte görünür. Elle gönderim ve geri çekme seçeneği kapatır.
- **Bekleyen faturası olan form gönderilemez:** Okuması süren varsa `409 okuma_suruyor`, okunamayan varsa `409 okuma_hatali` döner. Bekleyen faturalar 20 fatura sınırına sayılır.

### Fiş alanları, masraf merkezi ve zorunluluk kuralları

Alanlar `alan_tanimlari` tablosundadır; yönetici panelde "Alan yönetimi" sayfasından yönetir. Üç grup vardır:

| Grup | Alanlar | Yöneticinin değiştirebildikleri |
|---|---|---|
| Form alanları (`duzey: "form"`) | `kategori` (her zaman zorunlu), `masrafMerkezi` | `kategori`: yalnızca `aciklama`. `masrafMerkezi`: `zorunlu`, `aktif`, `aciklama` |
| Fatura bilgileri (`tur: "fatura"`) | Okunan faturanın başlık alanları: `faturaNo`, `faturaTarihi`, `saticiUnvan`, `saticiVergiNo`, `aliciUnvan`, `aliciVergiNo`, `paraBirimi`, `araToplam`, `kdvToplam`, `genelToplam`. Değerleri okumadan ya da düzeltmeden gelir | `zorunlu`, `aciklama` |
| Fiş alanları | Gönderenin her fiş için ayrı doldurduğu alanlar. Başlangıçta Etiket, Proje Kodu, Ödeme Yöntemi, Doküman Tipi, KKEG Türü (`liste`), Vergi Dairesi (`metin`) ve Not (`uzun_metin`) vardır; hepsi isteğe bağlı başlar | `ad`, `zorunlu`, `aktif`, `sira`, `aciklama`. Yönetici yeni alan ekler; değeri girilmemiş alanı siler |

Fiş alanı türleri: `liste` (alanın seçenek listesinden biri; seçenekler bir tanım listesidir, Excel ile içe aktarılır), `metin` (en çok 200 karakter), `uzun_metin` (en çok 1000), `sayi`, `tarih` (`YYYY-AA-GG`). Alanın türü sonradan değişmez. En çok 40 fiş alanı (pasifler dahil, fatura bilgileri hariç) tanımlanır.

- **Masraf merkezi ve organizasyon:** Yönetici kullanıcıya bir organizasyon ve bir ya da birden çok masraf merkezi tanımlar (`PATCH /api/kullanicilar/:id`). Gönderen formda kendisine tanımlı aktif masraf merkezlerinden birini seçer (`masrafMerkeziId`). Kullanıcıya tek aktif masraf merkezi tanımlıysa ve `POST /api/masraflar` içinde `masrafMerkeziId` gönderilmezse o seçilir. Gönderimde formun masraf merkezi sahibine hâlâ tanımlı ve aktif olmalıdır, değilse `409 alan_eksik` döner. Formun organizasyonu sahibinin organizasyonudur: sahibi formu her kaydettiğinde ve gönderdiğinde güncellenir, gönderilmiş formda değişmez. `masrafMerkezi` alanı pasifse formda gösterilmez, istek `masrafMerkeziId` taşıyamaz (`400`) ve form masraf merkezisiz gönderilir.
- **Değerler fişe aittir:** Formdaki her fatura ve okunmayı bekleyen her dosya kendi değerlerini taşır. Okuması bitmemiş dosyanın alanları da doldurulabilir. Dosya okunup faturaya dönüşünce değerleri faturaya geçer. Dosya formda zaten fatura olarak varsa (bekleyen satır sessizce silinir) faturanın kendi değerleri korunur. Formdan çıkarılan fişin değerleri silinir. Fatura bilgileri bu yolla değil, düzeltmeyle (`faturaDuzeltmeleri`) değişir.
- **Zorunluluk:** Bir alan, aktifse ve `zorunlu` işaretliyse ya da koşulu tutan bir kuralın hedefiyse zorunludur. Pasif alan hiçbir zaman zorunlu olmaz. Koşul alanı pasif olan kural uygulanmaz.
- **Kurallar** (`alan_kurallari`): "Koşul alanı şu değerdeyse şu alanlar zorunludur." Koşul alanı `kategori`, `masrafMerkezi` ya da `liste` türünde bir fiş alanıdır; değer o listenin bir kaydıdır. Örnekler: "Kategori = ARAÇ BAKIM ONARIM ise Etiket ve Proje Kodu zorunlu", "Doküman Tipi = Fatura ise Satıcı Vergi No zorunlu".
  - Koşul bir form alanıysa formun değerine bakılır. Hedefler formdaki her fişe uygulanır; hedef `masrafMerkezi` ise forma uygulanır.
  - Koşul bir fiş alanıysa yalnızca o fişe uygulanır ve hedefleri fiş alanları (fatura bilgileri dahil) olmalıdır.
  - Bir koşul değeri için tek kural olur; kuralın birden çok hedefi olabilir. `kategori` hedef olamaz, alan kendi kuralının hedefi olamaz.
  - Kuralın koşul değeri ya da koşul alanı silinince kural da silinir. Hedef alan silinince kuraldan çıkar; hedefsiz kalan kural silinir.
- **Saf kural:** `requiredFields` (`src/expenses/field-rules.ts`), alan tanımlarından, kurallardan, formun kategori ve masraf merkezinden ve fişin değerlerinden zorunlu alanları hesaplar. Panel (`public/js/fields.js`) ve mobil (`masraf-app/src/lib/fields.ts`) aynı hesabı yalnızca yıldız ve uyarı göstermek için tekrarlar; kararı sunucu verir.
- **Gönderim:** Eksik fatura bilgisi `409 fatura_eksik` döner. Eksik fiş alanı ya da masraf merkezi (seçilmemiş ya da artık sahibine tanımlı olmayan) `409 alan_eksik` döner. Taslak kaydetmek serbesttir. Yanıttaki `eksikAlanlar` listeleri (formda, her faturada ve her bekleyen dosyada) o an eksik olan zorunlu alanların anahtarlarıdır.
- **Pasif kayıtlar:** Pasif organizasyon, masraf merkezi, kategori ya da seçenek yeni bir seçimde kullanılamaz (`400`). Daha önce kaydedilmiş değer korunur, gösterilir ve aynı değerle yeniden kaydedilebilir. Kullanılan kayıt silinemez (`409 kullaniliyor`), pasifleştirilir.
- **Geçmiş:** Fiş alanlarındaki değişiklik, formun aynı istekteki `guncellendi` satırına eklenir. Okunmuş fatura için "1. faturanın alanları değişti: Etiket, Not.", okunmayı bekleyen dosya için "fis.jpg dosyasının alanları değişti: Etiket." yazılır. Masraf merkezi değişikliği "Masraf merkezi: 11033106 → 12043106." olarak yazılır.

## 4. Veritabanı (MSSQL)

Docker'daki SQL Server 2022 kullanılır (`docker compose up -d`). Sunucu açılışta veritabanını yoksa oluşturur ve `src/db/migrations/*.sql` dosyalarını sırayla uygular.

| Tablo | İçerik |
|---|---|
| `kullanicilar` | e-posta (benzersiz, küçük harf), ad soyad, rol, departman, şifre özeti (scrypt), aktif, `sifre_degismeli`, atanmış onay akışı (`onay_akisi_id`, boşsa varsayılan), organizasyon (`organizasyon_id`, `NULL` olabilir) |
| `organizasyonlar` | kod (benzersiz), ad, para birimi (`NULL` olabilir, bilgi amaçlı), aktif |
| `masraf_merkezleri` | kod (benzersiz), açıklama, aktif |
| `kullanici_masraf_merkezleri` | Kullanıcıya tanımlı masraf merkezleri |
| `alan_tanimlari` | Alanlar: anahtar (API adı, değişmez), ad (benzersiz), düzey (`form`/`fis`), tür, zorunlu, aktif, sıra, sistem alanı mı, açıklama |
| `alan_secenekleri` | `liste` türündeki alanların seçenekleri: alan, kod (alan içinde benzersiz), ad, aktif, sıra |
| `alan_kurallari`, `alan_kurali_hedefleri` | Zorunluluk kuralları: koşul alanı ve değeri (alan içinde benzersiz), hedef alanlar |
| `fis_alan_degerleri` | Formdaki faturanın fiş alanı değerleri (form, fatura kaydı, alan; seçenek ya da metin). Faturanın formdaki bağı silinince silinir |
| `bekleyen_alan_degerleri` | Okunmayı bekleyen dosyanın fiş alanı değerleri; dosya faturaya dönüşünce `fis_alan_degerleri`'ne geçer |
| `oturumlar` | Token'ın SHA-256 özeti, kullanıcı, istemci (`panel`/`mobil`/`api`), bitiş. Token'ın kendisi saklanmaz |
| `masraf_kategorileri` | ad, simge, sıra, aktif, kod, KDV oranları, hesap kodu (son üçü `NULL` olabilir; Excel ile taşınır) |
| `onay_akislari` | Akış adı (benzersiz), varsayılan mı (en fazla biri, filtreli benzersiz indeks), son değişiklik ve yapan |
| `onay_adimlari` | Akışın adımları: akış, sıra, onaycı, onay limiti (`NULL` = sınırsız). Sıra ve onaycı akış içinde benzersizdir. Akışın stratejisi `onay_akislari.strateji` alanındadır |
| `form_faturalari` | Formun faturaları: form, fatura kaydı, sıra, `aktif` (form iptal edilince 0), girilen yerel karşılık (`yerel_karsilik`), kullanıcının düzeltmesi (`duzeltme`, JSON, `NULL` = düzeltme yok), mükerrer anahtarı (`mukerrer_anahtari`, geçerli bilgiden; `aktif = 1` satırlarda indeksli). Bir fatura en fazla bir aktif bağda bulunur |
| `fatura_kayitlari` | Okunan fatura (JSON), ölçüm (JSON), dosya özeti, liste için özet alanlar |
| `fatura_dosyalari` | Orijinal dosya (`VARBINARY(MAX)`) ve MIME türü |
| `fatura_yuklemeleri` | Hangi kullanıcı hangi faturayı ne zaman yükledi. Erişim yetkisi buradan gelir |
| `masraf_formlari` | Form alanları, durum, tur, yerel tutar, onay tutarı, okununca gönder seçeneği (`okununca_gonder`), masraf merkezi ve organizasyon (ikisi de `NULL` olabilir). Tutar ve yerel tutar yalnızca `taslak` durumunda `NULL` olabilir |
| `bekleyen_faturalar` | Forma eklenmiş, okunmayı bekleyen ya da okunamamış dosyalar: form, yükleyen, dosya adı, SHA-256 özeti, MIME, boyut, içerik (`VARBINARY(MAX)`), durum (`bekliyor` ya da `hata`), hata kodu ve mesajı, eklenme. Bir dosya bir formda bir kez bulunur. Okunan dosyanın satırı silinir, fatura `form_faturalari`'na geçer |
| `form_onaylari` | Formun her turdaki onay adımları (akıştan kopya) |
| `form_gecmisi` | Formun zaman çizelgesi |
| `denetim_kayitlari` | Yönetici işlemleri |
| `bildirimler` | Uygulama içi bildirim: kullanıcı, tür, form (`NULL` olabilir), başlık, mesaj, oluşturma, okunma zamanı (`NULL` = okunmadı) |
| `eposta_kutusu` | Giden mail kutusu: alıcı kullanıcı (`NULL` = test maili), adres, konu, düz metin ve HTML gövde, ek türü (`masraf_pdf` ya da `NULL`), form, durum (`bekliyor`, `gonderildi`, `hata`, `atlandi`), deneme sayısı, son hata, sonraki deneme, oluşturma, gönderim |
| `entegrasyonlar` | Entegrasyon ayarları (bölüm 9): ad (benzersiz), aktif, adres, yöntem, biçim, kök ve liste adları, tarih biçimi, tetikleyici, kimlik türü, kullanıcı adı, şifrelenmiş şifre (`VARBINARY`), ek başlıklar ve alan eşlemesi (JSON), zaman aşımı |
| `entegrasyon_gonderimleri` | Entegrasyon gönderim kuyruğu ve kaydı: entegrasyon (silinince kayıt da silinir), form, tetikleyen, elle gönderen, durum (`bekliyor`, `gonderildi`, `hata`), deneme, HTTP durum kodu, son hata, son denemenin gövdesi ve yanıtın başı, sonraki deneme, oluşturma, gönderim |
| `sema_surumleri` | Uygulanan migration'lar |

`kullanicilar.mail_bildirim` (varsayılan 1) kullanıcının mail isteyip istemediğini, `form_onaylari.son_hatirlatma` bir adım için gönderilen son hatırlatmanın zamanını tutar. Bildirimdeki form başlığı, bildirim yazıldığı andaki başlıktır; form sonradan değişse de bildirimde değişmez.

Tutarlar `DECIMAL(18,2)`, kur `DECIMAL(18,6)`, zamanlar UTC `DATETIME2(3)`'tür. Ad, başlık ve satıcı gibi metinler `Turkish_100_CI_AS` sıralamasıyla saklanır.

## 5. Kimlik doğrulama

- `POST /api/oturum` başarılı girişte bir oturum açar.
  - `istemci: "panel"` ise `HttpOnly; SameSite=Strict` `masraf_oturum` çerezi gönderilir, token gövdede dönmez.
  - `"mobil"` veya `"api"` ise token gövdede döner. İstemci bu token'ı `Authorization: Bearer <token>` başlığıyla gönderir.
- Oturum süresi `OTURUM_SURESI_SAAT` ile ayarlanır ve kullanıldıkça uzar. Şifre değişince kullanıcının diğer oturumları kapanır.
- Arka arkaya hatalı girişte (`GIRIS_DENEME_SINIRI`) e-posta `GIRIS_KILIT_DAKIKA` süresince kilitlenir.
- Yöneticinin oluşturduğu ya da şifresini sıfırladığı kullanıcıda `sifreDegismeli: true` olur. İstemci kullanıcıyı şifre değiştirme ekranına yönlendirir. Şifre değişene kadar yalnızca `GET /api/ben`, `PUT /api/ben/sifre` ve `DELETE /api/oturum` çalışır; diğer uçlar `403 sifre_degismeli` döner.
- Şifre en az `SIFRE_MIN_UZUNLUK` (varsayılan 8), en çok 128 karakterdir ve en az bir harf ile bir rakam içerir.
- `/health` ve `POST /api/oturum` dışındaki bütün `/api` uçları oturum ister. Oturum yoksa `401 oturum_gerekli` döner.
- Kullanıcının göremediği form ya da fatura için `404 bulunamadi` döner; böylece başkasının kayıtlarının varlığı da sızmaz. `403 yetki_yok` yalnızca rolün yetmediği uçlarda (ör. çalışanın `GET /api/kullanicilar` isteği) ya da formu görebilen ama o işlemi yapamayan kişiye döner.
- Panel çerezi de oturumla birlikte uzar: oturum süresi ileri alındığında sunucu çerezi yeni `Max-Age` ile yeniden gönderir.
- Host ve Origin koruması aynen sürer. Sunucu varsayılan olarak yalnızca `127.0.0.1` üzerinde dinler. Mobil uygulama `adb reverse tcp:4000 tcp:4000` ile (Android) ya da iOS simülatöründe `127.0.0.1` üzerinden bağlanır. Gerçek iPhone ya da Wi-Fi'deki telefon için sunucu `AG_ERISIMI=yerel` ile yerel ağa açılır; o zaman yalnızca özel ağ adreslerinden gelen istekler kabul edilir, diğerleri `403 izinsiz_ag` alır.

## 6. API sözleşmesi

Bütün gövdeler JSON'dur. Hata gövdesi `{"hata": {"kod": "...", "mesaj": "...", "alanlar"?: {"alan": "mesaj"}, "sorunlar"?: ["..."]}}` biçimindedir. `mesaj` her zaman Türkçe ve kullanıcıya gösterilebilir. Tarihler `YYYY-MM-DD`, zamanlar ISO 8601 UTC'dir. Tutarlar sayıdır.

### Ortak nesneler

```jsonc
// Kullanici
{ "id": 3, "eposta": "ayse@firma.com", "adSoyad": "Ayşe Kaya", "rol": "calisan", "departman": "Satış",
  "aktif": true, "sifreDegismeli": false, "olusturma": "2026-11-06T09:00:00.000Z", "sonGiris": null,
  "mailBildirim": true,                                       // bildirimler mail olarak da gelsin mi (kullanıcının tercihi)
  "onayAkisiId": null,                                        // atanmış akış; null = varsayılan akışı kullanır
  "onayAkisi": { "id": 1, "ad": "Genel", "varsayilan": true }, // masraflarının şu an gittiği akış (her zaman dolu)
  "onaycilik": [                                              // onaycı olduğu akışlar (varsayılan önce, sonra ada göre); yoksa []
    { "akis": { "id": 1, "ad": "Genel", "strateji": "zincir" }, "sira": 1,
      "limit": 5000,                                          // son onayını verebileceği en yüksek tutar; null = sınırsız
      "altLimit": 0, "ustLimit": null } ],                    // bu tutar aralığındaki masraflar ona gelir (ustLimit null = üst sınır yok)
  "organizasyon": { "id": 1, "kod": "1000", "ad": "Şenpiliç Gıda Sanayi A.Ş.", "aktif": true },  // null = tanımlı değil
  "masrafMerkezleri": [                                       // tanımlı masraf merkezleri, koda göre; yoksa []. Formda yalnızca aktif olanlar seçilir
    { "id": 4, "kod": "11033106", "aciklama": "11033106", "gosterim": "11033106", "aktif": true } ] }

// Gösterim: bir kaydın kullanıcıya gösterilen adı. kod; ad (ya da açıklama) dolu ve koddan farklıysa "kod – ad"
// (araya boşluklu U+2013). Örnek: "P34MHG325 – P34MHG325-18036470", "Nakit".

// AkisOzet
{ "id": 2, "ad": "Satış", "varsayilan": false }

// KisiOzet
{ "id": 3, "adSoyad": "Ayşe Kaya" }

// Kategori
{ "id": 1, "ad": "Yemek", "simge": "yemek", "aktif": true, "sira": 1,
  "kod": null, "kdvOranlari": "0, 1, 10, 20", "hesapKodu": "7609901001" }   // son üçü metin ya da null
// simge: yemek | ulasim | konaklama | akaryakit | ofis | temsil | egitim | iletisim | diger

// AlanDegeri: bir fiş alanının değeri
{ "deger": 33,                  // istekte geri gönderilen değer: liste için seçenek kimliği, sayi için sayı, diğerlerinde metin (tarih YYYY-AA-GG)
  "gosterim": "P34MHG325 – P34MHG325-18036470" }   // liste için seçeneğin gösterimi; diğerlerinde değerin kendisi (sayıda String(deger))

// MasrafOzet (listelerde)
{ "id": 1001, "baslik": "Müşteri yemeği", "kategori": { "id": 1, "ad": "Yemek", "simge": "yemek" },
  "masrafTarihi": "2026-11-05", "satici": "Örnek Lokanta",
  "tutar": 1800, "paraBirimi": "TRY", "yerelTutar": 1800,     // tutar ve yerelTutar yalnızca taslakta null olabilir (girilmedi, okununca dolacak)
  "durum": "onayda", "olusturan": { "id": 3, "adSoyad": "Ayşe Kaya" }, "olusturma": "…", "gonderim": "…",
  "masrafMerkezi": { "id": 4, "kod": "11033106", "aciklama": "11033106", "gosterim": "11033106", "aktif": true },  // seçilmediyse null
  "organizasyon": { "id": 1, "kod": "1000", "ad": "Şenpiliç Gıda Sanayi A.Ş.", "aktif": true },               // sahibinin organizasyonu; yoksa null
  "siradakiOnayci": { "id": 2, "adSoyad": "Mehmet Demir" },   // durum onayda değilse null
  "faturaIdler": ["20261105-163012-0b9c44d1"],                // eklenme sırasıyla; faturasız formda []
  "okuma": null }                                             // bekleyen faturası yoksa null; varsa { "bekleyen": 2, "hatali": 0 }
                                                              // bekleyen: okunmayı bekleyen ya da okunan, hatali: okunamayan

// MasrafDetay = MasrafOzet + aşağıdakiler
{ "aciklama": "…", "kur": null, "onayTutari": 1800,   // son gönderimdeki onay tutarı; hiç gönderilmemiş formda null "tur": 1, "sonuclanma": null, "odeme": null, "guncelleme": "…",
  "okununcaGonder": false,       // bekleyen faturalar bitince sunucu formu onaya göndermeyi deneyecek mi
  "eksikAlanlar": [],            // formda eksik zorunlu alanlar; şimdilik yalnızca "masrafMerkezi" olabilir
  "bekleyenFaturalar": [         // eklenme sırasıyla; yoksa []
    { "dosyaOzeti": "9f86d0…(64 hex)", "dosyaAdi": "fis.jpg", "mime": "image/jpeg", "boyut": 482113, "eklenme": "…",
      "durum": "sirada",         // sirada | okunuyor | hata
      "kuyrukSirasi": 3,         // yalnızca sirada iken ve yeri belliyken dolu (1 = sıradaki); yoksa null
      "onundeki": 4,             // ondan önce okunacak ya da okunmakta olan dosya sayısı; kuyrukSirasi ile birlikte dolar
      "hata": null,              // durum hata iken { "kod": "claude_limit", "mesaj": "…" }
      "alanlar": { "etiket": { "deger": 33, "gosterim": "P34MHG325" } },  // girilmiş fiş alanı değerleri (aktif alanlar), anahtara göre; yoksa {}
      "eksikAlanlar": ["projeKodu"] } ],  // eksik zorunlu fiş alanları (fatura bilgileri okunmadan bilinmez, burada yer almaz)
  "faturalar": [                 // eklenme sırasıyla; faturasız formda []
    { "id": "…", "dosyaAdi": "fis.jpg", "dosyaVar": true, "mime": "image/jpeg", "faturaNo": "…",
      "dosyaOzeti": "9f86d0…",   // okunan dosyanın SHA-256'sı: hangi bekleyen dosyanın bu faturaya dönüştüğü (eski kayıtlarda null)
      "faturaTarihi": "2026-11-05", "saticiUnvan": "…", "genelToplam": 1800, "paraBirimi": "TRY",
      "karsilikGerekli": false,  // fatura üçüncü bir para biriminde: gönderim için yerelKarsilik gerekir
      "yerelKarsilik": null,     // gönderenin girdiği yerel karşılık; yalnızca karsilikGerekli iken dolu
      // Yukarıdaki okunan alanlar ve aşağıdakiler faturanın GEÇERLİ bilgisidir (düzeltme varsa düzeltme).
      "saticiVergiNo": "…", "aliciUnvan": "…", "aliciVergiNo": "…", "araToplam": 1525.42, "kdvToplam": 274.58,
      "kalemler": [ { "aciklama": "…", "miktar": 2, "birim": "adet", "birimFiyat": 762.71, "kdvOrani": 18, "tutar": 1525.42 } ],
      "duzeltildi": false,       // kullanıcı bu formda faturayı düzeltti mi
      "okunan": null,            // duzeltildi iken okunan sonuç ({ fatura, kalemler }), değilse null
      "alanlar": { "odemeYontemi": { "deger": 2, "gosterim": "Kredi Kartı" }, "not": { "deger": "Araç yıkama", "gosterim": "Araç yıkama" } },
                                 // girilmiş fiş alanı değerleri (aktif alanlar, fatura bilgileri hariç); yoksa {}
      "eksikAlanlar": [] } ],    // eksik zorunlu alanlar: önce fatura bilgileri (geçerli bilgide boş olanlar, şema sırasıyla), sonra fiş alanları (sıraya göre)
  "tutarFarki": null,            // ya da { "fatura": 1800, "beyan": 1500 } (fatura: toplama giren faturaların toplamı)
  "onaylar": [                   // yalnızca son tur, sıraya göre
    { "id": 10, "tur": 1, "sira": 1, "onayci": { "id": 2, "adSoyad": "Mehmet Demir" }, "altLimit": 0, "ustLimit": null, // onaycının akıştaki tutar aralığı (gönderimdeki kopya)
      "durum": "bekliyor", "aciklama": null, "kararTarihi": null, "yedek": false } ],
  "gecmis": [                    // eskiden yeniye
    { "islem": "gonderildi", "kullanici": { "id": 3, "adSoyad": "Ayşe Kaya" }, "aciklama": null, "tarih": "…" } ],
  "izinler": { "duzenle": false, "gonder": false, "geriCek": true, "iptal": false,
               "onayla": false, "reddet": false, "odendi": false, "devret": false } }
```

`gecmis.islem`: `olusturuldu`, `guncellendi`, `gonderildi`, `onaylandi`, `reddedildi`, `atlandi`, `tamamlandi`, `geri_cekildi`, `iptal_edildi`, `odendi`, `devredildi`.

`izinler` o anki kullanıcının bu formda yapabileceği işlemlerdir. İstemciler düğmeleri buna göre gösterir, kuralları kendileri hesaplamaz.

### Oturum ve profil

| İstek | Gövde | Yanıt |
|---|---|---|
| `POST /api/oturum` | `{ eposta, sifre, istemci?: "panel"\|"mobil"\|"api" }` | `200 { token?, bitis, kullanici }` · `401 hatali_giris` · `403 hesap_pasif` · `429 cok_fazla_deneme` |
| `DELETE /api/oturum` | | `204` |
| `GET /api/ben` | | `{ kullanici, bekleyenOnay, okunmamisBildirim }` (rozet sayaçları için hafif uç) |
| `PUT /api/ben/sifre` | `{ mevcutSifre, yeniSifre }` | `204` · `400 hatali_sifre` · `400 gecersiz_istek` |
| `PUT /api/ben/tercihler` | `{ mailBildirim: boolean }` | `Kullanici` (uygulama içi bildirim kapatılamaz) |
| `GET /api/ozet` | | Gösterge (aşağıda) |

```jsonc
// GET /api/ozet
{ "paraBirimi": "TRY",
  "benim": { "taslak": 1, "onayda": 2, "onaylandi": 5, "reddedildi": 0, "odendi": 9,
             "buAyToplam": 12450.5, "bekleyenTutar": 3200 },   // buAyToplam: son gönderimi bu ay olan ve şu an onayda, onaylandi, reddedildi ya da odendi durumundaki formların yerel tutarı (taslağa geri çekilen ve iptal edilenler sayılmaz)
  "bekleyenOnay": 3,
  "sonMasraflar": [ /* MasrafOzet, en yeni 5 */ ],
  "genel": { "onayda": 7, "odemeBekleyen": 4, "odemeBekleyenTutar": 15200, "buAyOnaylanan": 48200 } }  // yalnızca muhasebe/yonetici, diğerlerinde null
```

### Kullanıcılar (yonetici)

| İstek | Gövde | Yanıt |
|---|---|---|
| `GET /api/kullanicilar?q=&aktif=` | | `Kullanici[]` (ada göre) |
| `POST /api/kullanicilar` | `{ eposta, adSoyad, rol, departman?, sifre, onayAkisiId?, organizasyonId?, masrafMerkeziIdler? }` | `201 Kullanici` · `409 eposta_kullaniliyor` |
| `PATCH /api/kullanicilar/:id` | `{ eposta?, adSoyad?, rol?, departman?, aktif?, onayAkisiId?, organizasyonId?, masrafMerkeziIdler? }` | `Kullanici` · `409 eposta_kullaniliyor` · `409 kendi_hesabi` (kendini pasifleştirme) · `409 son_yonetici` · `409 onay_akisinda` · `409 bekleyen_onay_var` |
| `POST /api/kullanicilar/:id/sifre` | `{ yeniSifre }` | `204` (oturumları kapanır, `sifreDegismeli: true`) |
| `GET /api/denetim?adet=50` | | `[{ id, islem, ayrinti, kullanici: KisiOzet\|null, tarih }]` |

`onayAkisiId` bir akışın kimliği ya da `null`dır (varsayılan akışı kullan). Gönderilmezse değişmez (`POST`'ta `null`). Olmayan bir akış `400 gecersiz_istek` ve `alanlar.onayAkisiId` döner.

`organizasyonId` bir organizasyonun kimliği ya da `null`dır; gönderilmezse değişmez (`POST`'ta `null`). `masrafMerkeziIdler` kullanıcının masraf merkezlerinin tamamıdır (en çok 100, her biri bir kez; `[]` hepsini kaldırır); gönderilmezse değişmez (`POST`'ta `[]`). Olmayan kayıt ya da yeni tanımlanan pasif kayıt `400 gecersiz_istek` döner (`alanlar.organizasyonId`, `alanlar["masrafMerkeziIdler.<sıra>"]`). Zaten tanımlı olan pasif kayıt korunabilir. Masraf merkezinin kullanıcıdan kaldırılması kullanıcının taslaklarını değiştirmez; o taslaklar gönderilirken `409 alan_eksik` alır. Değişiklikler denetim kaydına yazılır.

### Onay akışları

| İstek | Kim | Gövde | Yanıt |
|---|---|---|---|
| `GET /api/onay-akislari` | yonetici | | `Akis[]` (varsayılan önce, sonra ada göre) |
| `POST /api/onay-akislari` | yonetici | `{ ad, strateji, adimlar: [{ onayciId, limit }] }` (`strateji`: `zincir` ya da `tek`; dizi sırası = onay sırası; son adımın `limit` değeri `null`) | `201 Akis` · `400 gecersiz_akis` (`sorunlar` listesiyle) · `409 akis_adi_kullaniliyor` |
| `GET /api/onay-akislari/:id` | yonetici | | `Akis` · `404 bulunamadi` |
| `PUT /api/onay-akislari/:id` | yonetici | `{ ad, strateji, adimlar }` (akışın tamamı yerine geçer) | `Akis` · `400 gecersiz_akis` · `409 akis_adi_kullaniliyor` |
| `POST /api/onay-akislari/:id/varsayilan` | yonetici | | `Akis` (artık varsayılan) |
| `DELETE /api/onay-akislari/:id` | yonetici | | `204` · `409 varsayilan_akis` (varsayılan silinemez) |
| `POST /api/onay-akisi/onizle` | herkes | `{ tutar, paraBirimi?, kur?, faturaIdler?, yerelKarsiliklar?, akisId? }` | `Onizleme` · `403 yetki_yok` (`akisId` gönderen yönetici değilse) |

```jsonc
// Akis
{ "id": 1, "ad": "Genel", "varsayilan": true, "strateji": "zincir", "paraBirimi": "TRY",
  "guncelleme": "…", "guncelleyen": { "id": 1, "adSoyad": "…" },   // guncelleyen null olabilir
  "kullaniciSayisi": 12,   // masrafları şu an bu akışa giden aktif kullanıcılar (varsayılan akışta atanmamış olanlar dahil)
  "adimlar": [ { "sira": 1, "onayci": { "id": 2, "adSoyad": "…", "eposta": "…", "departman": "…" }, "limit": 5000 },
               { "sira": 2, "onayci": { "id": 5, "adSoyad": "…", "eposta": "…", "departman": null }, "limit": null } ] }

// Onizleme: giriş yapan kullanıcı bu tutarla form gönderseydi
{ "onayTutari": 20000, "paraBirimi": "TRY", "akis": { "id": 2, "ad": "Satış", "varsayilan": false },
  "adimlar": [ { "sira": 1, "onayci": { "id": 2, "adSoyad": "…" }, "durum": "sirada", "yedek": false },
               { "sira": 2, "onayci": { "id": 5, "adSoyad": "…" }, "durum": "sirada", "yedek": false } ],
  "uyari": null }
// Önizlemede durum yalnızca "sirada" ya da "atlandi" (gönderenin kendi adımı) olur; ilk "sirada" adım ilk karar verecek kişidir.
// Kimse onaylayamıyorsa adimlar boş, uyari Türkçe açıklamadır (gönderim 409 onaylayan_yok verir).
// akisId verilmezse kullanıcının kendi akışı kullanılır. Yönetici akisId ile kaydedilmiş başka bir akışı
// kendisi göndermiş gibi deneyebilir (panelin "Tutar dene" kutusu); olmayan akış 404 döner.
```

### Kategoriler

| İstek | Kim | Gövde | Yanıt |
|---|---|---|---|
| `GET /api/kategoriler?tumu=1` | herkes (`tumu` yalnızca yonetici) | | `Kategori[]` |
| `POST /api/kategoriler` | yonetici | `{ ad, simge?, kod?, kdvOranlari?, hesapKodu? }` | `201 Kategori` · `409 kategori_var` |
| `PATCH /api/kategoriler/:id` | yonetici | `{ ad?, simge?, aktif?, sira?, kod?, kdvOranlari?, hesapKodu? }` | `Kategori` · `409 kategori_var` |
| `DELETE /api/kategoriler/:id` | yonetici | | `204` · `409 kullaniliyor` (bir formda kullanılıyor; pasifleştirin) |
| `GET /api/kategoriler/disa-aktar` | yonetici | | Excel (bölüm "Tanım listeleri") |
| `POST /api/kategoriler/ice-aktar` | yonetici | Excel dosyası | `IceAktarim` |

`kod`, `kdvOranlari` ve `hesapKodu` en çok 50 karakterlik metinlerdir; boş metin ya da `null` alanı temizler. Kategori silinince onu koşul olarak kullanan kurallar da silinir.

### Tanım listeleri (yonetici)

Organizasyonlar, masraf merkezleri, kategoriler (yukarıda) ve `liste` türündeki her fiş alanının seçenekleri tanım listeleridir. Hepsi aynı biçimde yönetilir ve Excel ile içe/dışa aktarılır.

| İstek | Kim | Gövde | Yanıt |
|---|---|---|---|
| `GET /api/organizasyonlar?q=&aktif=1\|0&sayfa=1&adet=50` | yonetici | | `{ kayitlar: Organizasyon[], toplam, sayfa, adet }` (koda göre) |
| `POST /api/organizasyonlar` | yonetici | `{ kod, ad, paraBirimi? }` | `201 Organizasyon` · `409 kod_kullaniliyor` |
| `PATCH /api/organizasyonlar/:id` | yonetici | `{ kod?, ad?, paraBirimi?, aktif? }` | `Organizasyon` · `409 kod_kullaniliyor` |
| `DELETE /api/organizasyonlar/:id` | yonetici | | `204` · `409 kullaniliyor` (kullanıcıya ya da forma bağlı) |
| `GET /api/masraf-merkezleri?q=&aktif=&sayfa=&adet=` | yonetici | | `{ kayitlar: MasrafMerkezi[], toplam, sayfa, adet }` (koda göre) |
| `POST /api/masraf-merkezleri` | yonetici | `{ kod, aciklama? }` | `201 MasrafMerkezi` · `409 kod_kullaniliyor` |
| `PATCH /api/masraf-merkezleri/:id` | yonetici | `{ kod?, aciklama?, aktif? }` | `MasrafMerkezi` · `409 kod_kullaniliyor` |
| `DELETE /api/masraf-merkezleri/:id` | yonetici | | `204` · `409 kullaniliyor` (kullanıcıya tanımlı ya da formda seçili) |
| `GET /api/alanlar/:anahtar/secenekler?q=&aktif=&sayfa=&adet=` | herkes | | `{ kayitlar: Secenek[], toplam, sayfa, adet }` (sıraya, sonra koda göre). Yönetici olmayan yalnızca aktif alanın aktif seçeneklerini görür (`aktif` yok sayılır). Alan yoksa, `liste` türünde değilse ya da yönetici olmayan için pasifse `404` |
| `POST /api/alanlar/:anahtar/secenekler` | yonetici | `{ kod, ad? }` | `201 Secenek` · `409 kod_kullaniliyor` |
| `PATCH /api/alanlar/:anahtar/secenekler/:id` | yonetici | `{ kod?, ad?, aktif?, sira? }` | `Secenek` · `409 kod_kullaniliyor` |
| `DELETE /api/alanlar/:anahtar/secenekler/:id` | yonetici | | `204` · `409 kullaniliyor` (bir fişte seçili) |
| `GET <liste>/disa-aktar` | yonetici | | `.xlsx` (bütün kayıtlar, pasifler dahil) |
| `POST <liste>/ice-aktar?onizleme=1&eksikleriPasiflestir=1` | yonetici | `.xlsx` dosyası | `IceAktarim` · `400 gecersiz_dosya` · `413 dosya_cok_buyuk` · `409 kod_kullaniliyor` (kategoride `kategori_var`; çok nadir: dosyadaki bir anahtar, uygulamanın farklı saydığı ama veritabanının eşit saydığı bir kayıtla çakıştı, hiçbir şey yazılmadı) |

`<liste>`: `/api/organizasyonlar`, `/api/masraf-merkezleri`, `/api/kategoriler` ya da `/api/alanlar/:anahtar/secenekler`.

```jsonc
// Organizasyon
{ "id": 1, "kod": "1000", "ad": "Şenpiliç Gıda Sanayi A.Ş.", "paraBirimi": "TRY", "aktif": true,
  "kullaniciSayisi": 12 }        // bu organizasyondaki aktif kullanıcılar
// MasrafMerkezi
{ "id": 4, "kod": "11033106", "aciklama": "11033106", "gosterim": "11033106", "aktif": true,
  "kullaniciSayisi": 3 }         // bu masraf merkezi tanımlı aktif kullanıcılar
// Secenek
{ "id": 33, "kod": "P34MHG325", "ad": "P34MHG325-18036470", "gosterim": "P34MHG325 – P34MHG325-18036470", "aktif": true, "sira": 0 }
// IceAktarim
{ "onizleme": true,              // true: hiçbir şey yazılmadı, sayılar yazılsaydı ne olacağını gösterir
  "satirSayisi": 258,            // başlık hariç, boş olmayan satırlar
  "eklenen": 216, "guncellenen": 0, "degismeyen": 0, "pasiflestirilen": 0,
  "hataSayisi": 42,
  "hatalar": [ { "satir": 44, "mesaj": "Kod boş." } ],          // Excel satır numarasıyla, en çok 100
  "sutunlar": { "kod": "MasrafMerkezi", "aciklama": "Açıklama" }, // hangi dosya sütunu hangi alana okundu
  "yokSayilanSutunlar": ["MasrafMerkeziNo", "ŞirketNo", "GlKod"] }
```

Alan kuralları: `kod` 1–50 karakterdir ve listede büyük/küçük harf ayrımı olmadan (Türkçe kurallarla) benzersizdir. `ad` (organizasyon) 1–200 karakterdir. `aciklama` ve seçeneğin `ad` alanı en çok 200 karakterdir; boşsa `null` olur. `paraBirimi` ISO 4217 koduna büyük harfle çevrilir ya da `null`dır. `q` kodda ve adda/açıklamada geçen metni arar. `aktif` verilmezse aktifler ve pasifler birlikte döner. `adet` 1–200, varsayılan 50. Yeni seçenek ve kategori listenin sonuna eklenir (`sira` en büyük sıranın bir fazlası; içe aktarmada dosya sırasıyla). Pasif kayıt yeni bir seçimde kullanılamaz ama mevcut değerler korunur. Kayıt silinince onu koşul olarak kullanan kurallar da silinir. Her ekleme, değişiklik, silme ve içe aktarma denetim kaydına yazılır.

**Excel dışa aktarma:** İlk satır başlıktır. Sütunlar şöyledir:

- Organizasyonlar: `Organizasyon Kodu`, `Organizasyon Adı`, `Para Birimi`, `Aktif`.
- Masraf merkezleri: `Masraf Merkezi`, `Açıklama`, `Aktif`.
- Kategoriler: `Kategori Adı`, `Kategori Kodu`, `KDV Oranları`, `Hesap Kodu`, `Simge`, `Aktif`.
- Seçenekler: `Kod`, `Açıklama`, `Aktif`.

`Aktif` sütunu `Evet` ya da `Hayır` yazar. Hücreler formül değil düz metindir. Dosya adı `<liste>_<YYYY-AA-GG>.xlsx` olur; `<liste>` listenin adıdır (`Organizasyonlar`, `Masraf Merkezleri`, `Kategoriler`, seçeneklerde alanın adı, ör. `Ödeme Yöntemi`), tarih sunucunun yerel tarihidir. `Content-Disposition` başlığında ASCII karşılığı (`filename`) ve asıl ad (`filename*`) birlikte gelir. Boş listenin dışa aktarımı içe aktarma şablonu olarak kullanılabilir.

**Excel içe aktarma:**

- **Dosya ve gönderim:** Dosya `.xlsx` olmalıdır (Excel 2007 ve sonrası). İstek gövdesinde ham olarak (`Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` ya da `application/octet-stream`) ya da `multipart/form-data` içinde `dosya` alanıyla gönderilir. En çok 5 MB olabilir, aşarsa `413 dosya_cok_buyuk` döner. Yalnızca ilk sayfa okunur; en çok 20.000 veri satırı ve 256 sütun (A–IV) alınır, daha sağdaki boş hücreler yok sayılır. `.xls`, `.csv`, bozuk dosya, şifreli dosya, açılınca çok büyüyen dosya, çok fazla satır ya da IV'nin sağında dolu bir hücre `400 gecersiz_dosya` döner.
- **Sütunlar:** İlk satır başlıktır. Başlıklar büyük/küçük harf, boşluk, noktalama ve Türkçe harf farkı gözetilmeden (ı→i, ş→s, ğ→g, ü→u, ö→o, ç→c) eşleştirilir. Tanınmayan sütunlar `yokSayilanSutunlar` içinde döner. Anahtar sütunu (aşağıda ilk sıradaki) yoksa `400 gecersiz_dosya` beklenen sütun adlarıyla döner. Tanınan başlıklar:
  - Organizasyonlar: kod ← `Kod`, `Organizasyon Kodu`, `Şirket Kodu`; ad ← `Ad`, `Organizasyon Adı`, `Şirket Adı`; paraBirimi ← `Para Birimi`; aktif ← `Aktif`, `Durum`.
  - Masraf merkezleri: kod ← `Kod`, `Masraf Merkezi`, `Masraf Merkezi Kodu`; aciklama ← `Açıklama`, `Ad`, `Masraf Merkezi Açıklaması`; aktif.
  - Kategoriler: ad ← `Ad`, `Kategori`, `Kategori Adı`; kod ← `Kod`, `Kategori Kodu`; kdvOranlari ← `KDV Oranları`, `KDV Oranı`; hesapKodu ← `Hesap Kodu`, `GL Kod`, `GL Kod 1`; simge ← `Simge`; aktif.
  - Seçenekler (alanın adı A, sonundaki "Kodu" atılmış hali B; ör. "Proje Kodu" için A = "Proje Kodu", B = "Proje"): kod ← `Kod`, `A`, `A Adı`, `B Kodu` (A "Kodu" ile bitmiyorsa `B Kodu` = `A Kodu`); ad ← `Ad`, `Açıklama`, `A Açıklaması`, `B Açıklaması`; aktif. Örnek: Etiket listesinde `EtiketAdı` koda, `EtiketAçıklaması` ada; Proje Kodu listesinde `Proje Kodu` koda, `Proje Açıklaması` ada okunur.
- **Eşleştirme:** Satır mevcut kayıtla anahtarı üzerinden eşleşir. Anahtar organizasyon, masraf merkezi ve seçenekte `kod`, kategoride `ad`'dır; büyük/küçük harf, tam genişlikli harf ve görünmez biçim karakteri farkı gözetilmez. Eşleşen kayıtta dosyada bulunan sütunlar güncellenir; anahtarın yazımı dosyadakiyle değişir. Dosyada olmayan sütunlara dokunulmaz. Eşleşmeyen satır yeni kayıt olur; `Aktif` boşsa aktif başlar. Yeni kategorinin simgesi boşsa `diger` olur.
- **Değerler:** Hücreler kırpılır. Sayı hücreleri yazıldığı gibi metne çevrilir (`11033106`, bilimsel gösterim değil). `Aktif` için `Evet`/`Hayır`, `E`/`H`, `Aktif`/`Pasif`, `1`/`0`, `true`/`false`, `Doğru`/`Yanlış` kabul edilir. Boş `Aktif` mevcut kayıtta değişiklik yapmaz.
- **Hatalı satırlar:** Bütünüyle boş satırlar atlanır. Anahtarı boş, alanı çok uzun, para birimi, simge ya da aktif değeri geçersiz olan satır ve dosyada daha önce geçen anahtar ("Bu kod dosyada 5. satırda da var.") hata sayılır. Hatalı satırlar atlanır, geçerli satırlar uygulanır.
- **Önizleme ve pasifleştirme:** `onizleme=1` ile hiçbir şey yazılmaz; yanıt yazılsaydı ne olacağını gösterir. Panel önce önizleme yapar, kullanıcı onaylayınca aynı dosyayı `onizleme` olmadan gönderir. `eksikleriPasiflestir=1` ile dosyada anahtarı geçmeyen aktif kayıtlar pasifleşir (hatalı satırların anahtarları dosyada geçmiş sayılır). Hiçbir satırında anahtar olmayan dosya bütün listeyi pasifleştireceği için bu seçenekle `400 gecersiz_dosya` döner.
- **Yazma:** İçe aktarma tek transaction içinde ve liste başına sıralı (`sp_getapplock`) yazılır. Denetim kaydına sayılarla birlikte tek satır düşer.

### Fiş alanları

| İstek | Kim | Gövde | Yanıt |
|---|---|---|---|
| `GET /api/alanlar?tumu=1` | herkes (`tumu` yalnızca yonetici) | | `{ alanlar: AlanTanimi[], kurallar: AlanKurali[] }` |
| `POST /api/alanlar` | yonetici | `{ ad, tur, zorunlu?, aciklama? }` (`tur`: `liste`, `metin`, `uzun_metin`, `sayi`, `tarih`) | `201 AlanTanimi` · `409 alan_adi_kullaniliyor` · `409 alan_siniri` |
| `PATCH /api/alanlar/:id` | yonetici | `{ ad?, zorunlu?, aktif?, sira?, aciklama? }` | `AlanTanimi` · `400 gecersiz_istek` (alanın değiştirilemeyen bir özelliği; `alanlar.<özellik>`: "Bu alanın … değiştirilemez.") · `409 alan_adi_kullaniliyor` |
| `DELETE /api/alanlar/:id` | yonetici | | `204` · `409 sistem_alani` · `409 alan_kullaniliyor` (değer girilmiş; pasifleştirin) |
| `POST /api/alan-kurallari` | yonetici | `{ kosulAlan, kosulDegerId, hedefler: [anahtar] }` | `201 AlanKurali` · `409 kural_var` |
| `PUT /api/alan-kurallari/:id` | yonetici | `{ kosulAlan, kosulDegerId, hedefler }` (kuralın tamamı) | `AlanKurali` · `409 kural_var` |
| `DELETE /api/alan-kurallari/:id` | yonetici | | `204` |

```jsonc
// AlanTanimi
{ "id": 13, "anahtar": "etiket", "ad": "Etiket", "duzey": "fis",   // duzey: form | fis
  "tur": "liste",                // kategori | masraf_merkezi | fatura | liste | metin | uzun_metin | sayi | tarih
  "zorunlu": false, "aktif": true, "sira": 11,
  "sistem": false,               // kategori, masrafMerkezi ve fatura bilgileri: silinemez, yalnızca bölüm 3'teki özellikleri değişir
  "aciklama": null,              // alanın yanında gösterilen yardım metni (en çok 200)
  "secenekSayisi": 1086,         // yalnızca liste türünde: aktif seçenek sayısı; diğerlerinde null
  "kullanim": 12 }               // yalnızca tumu=1 yanıtında: bu alana değer girilmiş fiş sayısı (0 ise silinebilir); diğerlerinde yok
// AlanKurali
{ "id": 3, "kosulAlan": "kategori",
  "kosulDeger": { "id": 12, "gosterim": "ARAÇ BAKIM ONARIM", "aktif": true },
  "hedefler": ["etiket", "projeKodu"] }   // alan anahtarları
```

- `alanlar` önce form düzeyi, sonra `sira`, sonra `id` sırasıyla döner; kuralın `hedefler` dizisi de aynı sırayla döner (istekteki sıra korunmaz). `tumu` olmadan yalnızca aktif alanlar döner. Kurallardan yalnızca koşul alanı aktif olanlar döner; hedefleri aktif alanlara indirgenir, hedefi kalmayan kural dönmez.
- Yeni alanın anahtarı addan üretilir: Türkçe harfler ASCII'ye çevrilir, kelimeler camelCase birleşir (ör. "Araç Plakası" → `aracPlakasi`), harfle başlamıyorsa başına `alan` eklenir, en çok 40 karakter olur. Anahtar alınmışsa sonuna 2, 3, … eklenir. Anahtar sonradan değişmez.
- `ad` 1–60 karakterdir ve büyük/küçük harf ayrımı olmadan benzersizdir. `sira` tam sayıdır; panel iki alanın sırasını değiştirerek yukarı/aşağı taşır.
- Kural doğrulaması:
  - `kosulAlan` şunlardan biri olmalıdır: `kategori`, `masrafMerkezi` ya da `liste` türünde bir fiş alanının anahtarı (alan pasif olabilir). Değilse `400`, `alanlar.kosulAlan`.
  - `kosulDegerId` o listenin bir kaydı olmalıdır (kayıt pasif olabilir). Değilse `400`, `alanlar.kosulDegerId`.
  - `hedefler` 1–40 farklı alan anahtarıdır. Bunlar `kategori` ya da koşul alanının kendisi olamaz. Koşul bir fiş alanıysa hedefler de fiş alanı olmalıdır. Aykırılık `400` ve `alanlar["hedefler.<sıra>"]` döner.
  - Aynı koşul değeri için başka kural varsa `409 kural_var` döner.
- Alan silinince seçenekleri, onu koşul olarak kullanan kurallar ve kurallardaki hedefliği de silinir. Hedefi kalmayan kural da silinir.

### Masraf formları

| İstek | Gövde | Yanıt |
|---|---|---|
| `GET /api/masraflar?kapsam=benim\|tumu&durum=onayda,taslak&q=&sayfa=1&adet=20` | | `{ kayitlar: MasrafOzet[], toplam, sayfa, adet }` (`tumu` yalnızca muhasebe/yonetici) |
| `POST /api/masraflar` | `{ baslik, kategoriId, masrafTarihi, tutar?, paraBirimi?, kur?, satici?, aciklama?, masrafMerkeziId?, faturaIdler?, bekleyenFaturalar?, okununcaGonder?, yerelKarsiliklar?, faturaDuzeltmeleri?, fisAlanlari?, gonder? }` | `201 MasrafDetay` · `409 fatura_kullaniliyor` · `409 tanim_degisti` · `gonder: true` iken gönderim kodları (`okuma_suruyor`, `tutar_eksik`, `fatura_eksik`, `alan_eksik`, `fatura_mukerrer`, `karsilik_eksik`, `onaylayan_yok`) |
| `GET /api/masraflar/:id` | | `MasrafDetay` (sahibi, onaycıları, muhasebe, yonetici) |
| `PATCH /api/masraflar/:id` | POST ile aynı alanlar, hepsi isteğe bağlı (`gonder` hariç) | `MasrafDetay` · `409 fatura_kullaniliyor` · `409 tanim_degisti` (seçilen kategori, masraf merkezi, alan ya da seçenek kayıt sırasında yönetici tarafından silindi; yeniden yükleyip deneyin) |
| `POST /api/masraflar/:id/gonder` | | `MasrafDetay` · `409 okuma_suruyor` · `409 okuma_hatali` · `409 tutar_eksik` · `409 fatura_eksik` · `409 alan_eksik` · `409 fatura_mukerrer` · `409 karsilik_eksik` · `409 onaylayan_yok` |
| `POST /api/masraflar/:id/yeniden-oku` | | `MasrafDetay` (okunamayan bekleyen faturalar yeniden sıraya girer; okunamayan yoksa değişiklik olmaz) · yalnızca sahibi, `taslak`/`reddedildi` |
| `GET /api/masraflar/:id/pdf` | | `application/pdf` onay belgesi; organizasyon, masraf merkezi ve her faturanın fiş alanı değerleri de yazılır (formu görebilen herkes; yalnızca `onaylandi` ve `odendi` durumunda, diğerlerinde `409 gecersiz_durum`) |
| `POST /api/masraflar/:id/geri-cek` | | `MasrafDetay` |
| `POST /api/masraflar/:id/iptal` | | `MasrafDetay` |
| `POST /api/masraflar/:id/onayla` | `{ aciklama? }` | `MasrafDetay` · `409 onay_beklemiyor` |
| `POST /api/masraflar/:id/reddet` | `{ aciklama }` (en az 3 karakter) | `MasrafDetay` |
| `POST /api/masraflar/:id/odendi` | | `MasrafDetay` |
| `POST /api/masraflar/:id/devret` | `{ onayId, yeniOnayciId }` | `MasrafDetay` |
| `GET /api/masraflar/disa-aktar?durum=&baslangic=&bitis=` | | `text/csv` (UTF-8 BOM, `;` ayraçlı; Excel uyumlu). Son iki sütun `Organizasyon` ve `Masraf Merkezi`dir (gösterim; yoksa boş) |
| `GET /api/onaylar?durum=bekleyen\|karar` | | `MasrafOzet[]`: benim kararımı bekleyenler (eskiden yeniye) ya da karar verdiklerim (yeniden eskiye) |

Alan kuralları: `baslik` 1–120 karakter. `masrafTarihi` gelecekte olamaz. `tutar` 0'dan büyük, en çok 2 ondalık; taslakta gönderilmeyebilir ya da `null` olabilir (okununca dolar, bölüm 3). `reddedildi` durumundaki formun tutarı boşaltılamaz (`400`, `alanlar.tutar`). Tutarı boş form gönderilemez (`409 tutar_eksik`, `alanlar.tutar`). `paraBirimi` ISO 4217 (varsayılan `PARA_BIRIMI`). `kur` para birimi farklıysa zorunlu. `faturaIdler` en çok 20 farklı fatura kimliğidir; her biri kullanıcının yüklediği bir fatura olmalı ve iptal edilmemiş başka bir formda kullanılmamalıdır. Yüklemediği fatura `400 gecersiz_istek` ve `alanlar["faturaIdler.<sıra>"]` döner; başka formdaki fatura `409 fatura_kullaniliyor` döner, hangi faturanın sorunlu olduğu yine `alanlar["faturaIdler.<sıra>"]` içindedir (sıra 0'dan başlar). İki istek aynı faturayı aynı anda alırsa ikincisi `alanlar` olmadan `409 fatura_kullaniliyor` alabilir. Fatura başka bir kullanıcının formundaysa mesaj o formun numarasını vermez. `yerelKarsiliklar` fatura kimliğinden yerel para birimindeki tutara bir eşlemedir (`{ "<faturaId>": 6500 }`, tutar 0'dan büyük, en çok 2 ondalık). Yalnızca formdaki faturalar için verilebilir (`400`, `alanlar["yerelKarsiliklar.<faturaId>"]`). Karşılığa ihtiyacı olmayan faturanın karşılığı saklanmaz. Gönderimde eksik karşılık `409 karsilik_eksik` döner; eksik her fatura `alanlar["yerelKarsiliklar.<faturaId>"]` içindedir. Durumu uygun olmayan işlem `409 gecersiz_durum` döner.

`faturaDuzeltmeleri` fatura kimliğinden düzeltmeye bir eşlemedir (`{ "<faturaId>": { fatura, kalemler } | null }`). Yalnızca listelenen faturalar değişir; `null` düzeltmeyi kaldırır (okunan sonuca döner); listelenmeyenlerin düzeltmesi korunur. Değer faturanın şemasının tamamıdır (`src/invoice/schema.ts`; metin boşsa `null`, tarih `YYYY-MM-DD`, para birimi ISO 4217, en çok 200 kalem). Yalnızca formda (bu istekteki `faturaIdler` uygulandıktan sonra) bulunan faturalar için verilebilir. Hatalar `400 gecersiz_istek` ve `alanlar["faturaDuzeltmeleri.<faturaId>.fatura.faturaTarihi"]` gibi yollarla döner. `409 fatura_eksik` her eksik alanı `alanlar["faturalar.<faturaId>.<alan>"]` ("Bu alan okunamadı; doldurun.") ile döner. `409 fatura_mukerrer` sorunlu faturayı `alanlar["faturalar.<faturaId>"]` ile döner. Fatura okunur okunmaz (form oluşmadan) düzeltilebilir: istemci okunan sonucu gösterir, kullanıcı düzeltir ve düzeltmeyi `POST /api/masraflar` ile gönderir. `POST /api/onay-akisi/onizle` de `faturaDuzeltmeleri` alır, böylece önizlemedeki onay tutarı düzeltilmiş toplamlarla hesaplanır.

`bekleyenFaturalar` okuması bitmemiş dosyaların SHA-256 özetleridir (`dosyaOzeti`, 64 küçük harf onaltılık; en çok 20, her biri bir kez). Gönderilirse formun bekleyen faturalarının tamamı yerine geçer; gönderilmezse bekleyen faturalar değişmez. Listedeki her özet için sunucu sırasıyla şuna bakar:

1. Dosya bu formda zaten bekleyen fatura ise olduğu gibi kalır (durumu `hata` olsa da).
2. Kullanıcının yüklediği ve hâlâ okunmakta olan bir dosyaysa bekleyen fatura olarak forma eklenir.
3. Dosya okunmuş ve kullanıcı yüklemişse fatura kaydı fatura listesinin sonuna eklenir (listede yoksa). Böylece istemcinin bilmediği bir anda okuması biten dosya kaybolmaz.
4. Hiçbiri değilse (ör. sunucu yeniden başladı ve dosya okunmadan bellekten silindi) `400 gecersiz_istek`, `alanlar["bekleyenFaturalar.<sıra>"]`: "Bu dosya sunucuda bulunamadı; faturayı yeniden yükleyin."

Listede olmayan bekleyen faturalar formdan çıkarılır (okumaları sürer, okununca kullanıcının fatura listesine düşer). `faturaIdler` gönderen istemci, ekranda okunmakta olan dosyaların özetlerini de `bekleyenFaturalar` ile göndermelidir; böylece istemcinin haberi olmadan okunup forma eklenmiş fatura `faturaIdler` listesinde yok diye çıkarılmaz (3. kural onu yeniden ekler). Fatura listesi ile bekleyen faturaların toplamı en çok 20'dir. Bekleyen faturalar geçmişe "2 fatura okunmayı bekliyor." biçiminde yazılır.

`masrafMerkeziId` formun masraf merkezidir (bölüm 3, "Fiş alanları, masraf merkezi ve zorunluluk kuralları"): sahibine tanımlı aktif bir masraf merkezinin kimliği ya da `null`. Formda zaten kayıtlı olan değer, sonradan pasifleşmiş ya da sahibinden kaldırılmış olsa da yeniden gönderilebilir. Başka bir değer `400` ve `alanlar.masrafMerkeziId` döner ("Bu masraf merkezi size tanımlı değil." ya da "Bu masraf merkezi pasif."). `PATCH` içinde gönderilmezse değişmez. `POST` içinde gönderilmezse sahibine tek aktif masraf merkezi tanımlıysa o seçilir, değilse boş kalır.

`fisAlanlari` fişten fiş alanı değerlerine bir eşlemedir:

```jsonc
"fisAlanlari": {
  "20261105-163012-0b9c44d1": { "etiket": 33, "projeKodu": 5, "not": "Araç yıkama" },  // okunmuş fatura: fatura kimliğiyle
  "9f86d0…(64 hex)": { "odemeYontemi": 2, "not": null } }                              // okunmayı bekleyen dosya: dosya özetiyle
```

- **Fiş anahtarı:** Bir fatura kimliği ya da 64 karakterlik bir dosya özetidir. Fiş, bu istekteki `faturaIdler` ve `bekleyenFaturalar` uygulandıktan sonra formda olmalıdır. Dosya özeti formdaki bekleyen bir dosyayı ya da `dosyaOzeti` bu olan bir faturayı gösterir. Böylece istemci, okuması kendisinin haberi olmadan biten dosyanın değerlerini de özetiyle gönderebilir. Formda olmayan fiş `400` ve `alanlar["fisAlanlari.<fişAnahtarı>"]` döner ("Bu fiş formda yok."). Aynı fişi gösteren iki anahtar da `400` döner.
- **Değiştirme:** Verilen her fişin değerleri bu eşlemeyle tamamen değişir: eşlemede olmayan aktif alanların değeri silinir. Pasif alanların kayıtlı değerleri korunur. Verilmeyen fişlerin değerleri değişmez.
- **Değerler:**
  - `liste`: alanın seçeneğinin kimliği (tam sayı).
  - `metin`: en çok 200, `uzun_metin`: en çok 1000 karakter; metin kırpılır.
  - `sayi`: sonlu bir sayı.
  - `tarih`: `YYYY-AA-GG` biçiminde, takvimde var olan bir gün.
  - `null` ya da boş metin değeri siler.
  - Yeni seçilen seçenek aktif olmalıdır; kayıtlı seçenek pasifleşmişse aynı değerle yeniden gönderilebilir.
- **Hatalar:** Hatalı değer `400` ve `alanlar["fisAlanlari.<fişAnahtarı>.<alanAnahtarı>"]` döner. Bilinmeyen, pasif ya da fiş alanı olmayan bir anahtar (`kategori`, `masrafMerkezi`, fatura bilgileri) da aynı yolla "Bu alan fişte kullanılmıyor." döner.
- `409 alan_eksik`, forma ait eksikler için `alanlar.masrafMerkeziId` ("Masraf merkezi seçilmeli." ya da "Seçili masraf merkezi size artık tanımlı değil; başka birini seçin.") döner. Fişlere ait eksikler için `alanlar["fisAlanlari.<faturaId>.<alanAnahtarı>"]` ("<Alan adı> zorunlu.") döner.

`okununcaGonder` (boolean) okununca gönder seçeneğidir (bölüm 3). `POST` içinde varsayılanı `false`'tur; `PATCH` içinde gönderilmezse değişmez. `gonder: true` ile birlikte `okununcaGonder: true` gönderilemez (`400`). `gonder: true` iken formda bekleyen fatura kalırsa `409 okuma_suruyor` döner ve form oluşturulmaz.

Doğrulama hatası: `400 gecersiz_istek`, `alanlar` her alanın Türkçe hata mesajını taşır.

Ayrıntılar:

- `POST /api/masraflar` ile `gonder: true` tek işlemdir. Gönderim başarısız olursa (ör. `409 onaylayan_yok`) form da oluşturulmaz; istemci aynı gövdeyi `gonder: false` ile taslak olarak kaydedebilir.
- `PATCH` içinde `kur`, `satici` ve `aciklama` alanlarına `null` (metinlerde boş metin de olur) gönderilirse alan temizlenir. Gönderilmeyen alan değişmez.
- `faturaIdler` gönderilirse formun fatura listesinin tamamı yerine geçer (sıra dahil). Fatura eklemek ya da çıkarmak için istemci güncel listenin tamamını gönderir; `[]` bütün faturaları kaldırır. Gönderilmezse faturalar değişmez. Listedeki değişiklik form geçmişine yazılır ("1 fatura eklendi, 1 fatura çıkarıldı.").
- `yerelKarsiliklar` gönderilirse bütün karşılıkların yerine geçer. Gönderilmezse formda kalan faturaların karşılıkları korunur. Formun para birimi değişip bir fatura artık karşılık gerektirmiyorsa karşılığı silinir.
- `tutarFarki.fatura` ve `tutarFarki.beyan` formun kendi para birimindedir (`paraBirimi`). `tutarFarki.fatura`, 6. kuraldaki gibi toplama giren faturaların toplamıdır; yerel para birimindeki tutarlar (yerel faturalar ve girilen karşılıklar) formun kuruyla formun para birimine çevrilir. Toplama giren en az bir fatura varsa ve iki tutar kuruşa yuvarlandığında farklıysa dolar. Karşılığı girilmemiş fatura toplama girmez.
- Temel para birimi (`PARA_BIRIMI`) `GET /api/ozet` ve `GET /api/onay-akislari` yanıtlarındaki `paraBirimi` alanından okunur.
- `null` olabilen alanlar: `Kullanici.departman`, `Kullanici.sonGiris`, `Kullanici.onayAkisiId`, `Akis.guncelleyen`, `MasrafOzet.satici`, `MasrafOzet.tutar` ve `MasrafOzet.yerelTutar` (yalnızca taslakta), `MasrafOzet.gonderim`, `MasrafOzet.siradakiOnayci`, `MasrafOzet.okuma`, `MasrafDetay.aciklama`, `kur`, `onayTutari`, `sonuclanma`, `odeme`, `faturalar` içindeki okunan alanlar (`faturaNo`, `faturaTarihi`, `saticiUnvan`, `genelToplam`, `paraBirimi`, `mime`) ve `yerelKarsilik`, `bekleyenFaturalar` içindeki `kuyrukSirasi`, `onundeki` ve `hata`, `MasrafOzet.masrafMerkezi`, `MasrafOzet.organizasyon`, `Kullanici.organizasyon`, `Kategori.kod`, `Kategori.kdvOranlari`, `Kategori.hesapKodu`, `Organizasyon.paraBirimi`, `MasrafMerkezi.aciklama`, `Secenek.ad`, `AlanTanimi.aciklama` ve `AlanTanimi.secenekSayisi`. `Kategori.simge` her zaman doludur (varsayılan `diger`). `faturaIdler`, `faturalar`, `bekleyenFaturalar`, `eksikAlanlar` ve `Kullanici.masrafMerkezleri` her zaman dizi, `alanlar` (faturada ve bekleyen dosyada) her zaman nesnedir.
- Çoklu yükleme kuyruğu (`GET /api/invoices/toplu/:id`) sunucunun belleğindedir; sunucu yeniden başlarsa `404` döner. Okunmuş faturalar kaybolmaz: `GET /api/invoices` kullanıcının yüklediklerini en yeniden listeler. Bir forma bekleyen fatura olarak kaydedilmiş dosyalar veritabanındadır ve yeniden başlayan sunucu onları okumaya devam eder.
- `GET /api/onaylar` sayfalanmaz: `bekleyen` bekleyenlerin hepsini, `karar` son 200 kararı döner.
- Devretme: yalnızca karar verilmemiş adım (`bekliyor` ya da `sirada`) devredilir. Yeni onaycı aktif olmalı; formun sahibi, adımın şimdiki onaycısı ya da bu turda zaten bekleyen/sıradaki bir adımı olan kişi olamaz. Aykırı istekler `400 gecersiz_istek` ve `alanlar.onayId` ya da `alanlar.yeniOnayciId` ile döner. Devredilen eski onaycı form ve faturasını artık göremez (`404`).
- Para birimi değiştirilip yeni `kur` verilmezse eski kur taşınmaz: yeni para birimi temel para birimi değilse `400` ve `alanlar.kur` döner.
- `alanlar` anahtarları alan adlarıdır; dizi ve iç içe alanlarda yol olarak yazılır (`adimlar.0.limit`, `durum.0`). Belirli bir alana bağlanamayan hata (ör. bilinmeyen alan) `_` anahtarındadır. Devretme yalnızca yönetici işidir ve kullanıcı listesi gerektirdiği için panelden yapılır.

### Bildirimler

| İstek | Gövde | Yanıt |
|---|---|---|
| `GET /api/bildirimler?okunmamis=1&sayfa=1&adet=20` | | `{ kayitlar: Bildirim[], toplam, okunmamis, sayfa, adet }` (en yeni önce; yalnızca kendi bildirimleri; `adet` en çok 100) |
| `POST /api/bildirimler/:id/okundu` | | `204` (başkasının bildirimi `404`) |
| `POST /api/bildirimler/hepsi-okundu` | | `204` |

```jsonc
// Bildirim
{ "id": 41, "tur": "onay_bekliyor", "baslik": "Onayınızı bekleyen masraf",
  "mesaj": "Ayşe Kaya, \"Müşteri yemeği\" masrafını (1.800,00 TRY) onayınıza gönderdi.",
  "form": { "id": 1001, "baslik": "Müşteri yemeği" },   // null olabilir
  "olusturma": "…", "okundu": false }
// tur: onay_bekliyor | hatirlatma | devredildi | onaylandi | reddedildi | odendi | odeme_bekliyor
//      | okuma_bitti | okuma_hatasi | onaya_gonderildi | onaya_gonderilemedi
```

### E-posta (yonetici)

| İstek | Gövde | Yanıt |
|---|---|---|
| `POST /api/eposta/deneme` | `{ alici? }` (boşsa yöneticinin kendi adresi) | `202 { id }` · `409 mail_kapali` (`MAIL_GONDERIM=kapali`) |
| `GET /api/eposta?durum=hata&adet=50` | | `[{ id, alici, konu, durum, deneme, sonHata, olusturma, gonderim }]` (en yeni önce; gövde ve ek dönmez) |
| `POST /api/eposta/:id/yeniden` | | `202` (yalnızca `hata` durumundaki mail; deneme sayısı sıfırlanır) · `409 gecersiz_durum` (mail `hata` durumunda değil) · `409 mail_kapali` |

`durum` süzgeci `bekliyor`, `gonderildi`, `hata` ya da `atlandi` olur. Test maili ve yeniden deneme denetim kaydına `eposta_deneme` ve `eposta_yeniden` olarak yazılır.

### Faturalar (mevcut uçlar, artık oturum ister)

| İstek | Değişiklik |
|---|---|
| `POST /api/invoices`, `POST /api/invoices/toplu` | Yükleyen kullanıcı kaydedilir, orijinal dosya veritabanında saklanır |
| `GET /api/invoices` | `calisan` yalnızca kendi yüklediklerini görür |
| `GET /api/invoices/:id` | Yükleyen, faturayı kullanan (ya da iptal edilmeden önce kullanmış) formun sahibi ve onaycıları, muhasebe, yonetici |
| `GET /api/invoices/:id/dosya` | **Yeni.** Orijinal dosya, doğru `Content-Type` ile. Dosyası olmayan eski kayıtlarda `404` |
| `GET /api/invoices/toplu/:id` | Yalnızca kuyruğu oluşturan kullanıcı (ve muhasebe/yonetici) |
| `GET /api/izleme`, `/api/izleme/akis` | `calisan` yalnızca kendi etkinliklerini görür; sayaçlar geneldir |

Çoklu yüklemenin (`POST /api/invoices/toplu`, `GET /api/invoices/toplu/:id`) her dosyasında ve canlı izlemenin her etkinliğinde okuma sırası alanları bulunur:

```jsonc
// Kuyruk.dosyalar[] öğesi (mevcut alanlara ek)
{ "dosyaOzeti": "9f86d0…(64 hex)",   // dosyanın SHA-256 özeti; sunucunun reddettiği dosyada null
  "kuyrukSirasi": 3,                  // durum sirada iken Claude'u bekleyenler arasındaki yeri (1 = sıradaki); yoksa null
  "onundeki": 4 }                     // ondan önce okunacak ya da okunmakta olan dosya sayısı; kuyrukSirasi ile birlikte dolar
// Etkinlik (GET /api/izleme): aynı kuyrukSirasi ve onundeki alanları. kaynak: panel | api | arka_plan
// (arka_plan: sunucunun kendisinin başlattığı okuma; yeniden başlayınca kalan bekleyen faturalar ya da "yeniden oku")
```

Mobil için önerilen okuma akışı: dosyayı `POST /api/invoices/toplu` ile gönder (`202`), `GET /api/invoices/toplu/:id` ile birkaç saniyede bir sor. Dosya `sirada` iken `kuyrukSirasi` ve `onundeki` ile "Sırada 3. · önünde 4 fatura var" gösterilir. Dosya `bitti` olunca `kayitId` ve `sonuc` gelir. Formu `sonuc.fatura` ile doldur (`genelToplam` → tutar, `paraBirimi`, `faturaTarihi` → masraf tarihi, `saticiUnvan` → satıcı), `faturaIdler: [kayitId]` ile kaydet. Birden çok fiş için her dosyanın `kayitId` değeri listeye eklenir ve tutar, aynı para birimindeki genel toplamların toplamıyla doldurulur. Formun ve yerel para biriminin dışındaki bir fişin yerel karşılığı kullanıcıdan istenir ve `yerelKarsiliklar` ile gönderilir. Okuma sırasında kullanıcı kategori ve açıklama girebilir. Kullanıcı okumaları beklemeden kaydedebilir: okunmuş dosyalar `faturaIdler`, okunmakta olanlar `bekleyenFaturalar` (her birinin `dosyaOzeti`) ile gönderilir, tutar boş bırakılabilir, istenirse `okununcaGonder: true` eklenir. Kaydedilmiş formda bekleyen faturaların durumu `GET /api/masraflar/:id` yanıtındaki `bekleyenFaturalar` ile izlenir (birkaç saniyede bir sorulur).

## 7. Bildirimler ve e-posta

Bildirimler ve mailler, onları doğuran işlemle **aynı transaction'da** `bildirimler` ve `eposta_kutusu` tablolarına yazılır. İşlem geri alınırsa bildirim de oluşmaz. Uygulama içi bildirim her zaman oluşur (pasif kullanıcıya da). Mail yalnızca alıcı aktifse ve `mail_bildirim = 1` ise kuyruğa girer. `odeme_bekliyor` yalnızca aktif muhasebe kullanıcılarına gider. İşlemi yapan kişiye kendi işlemi için bildirim gitmez. Maildeki bağlantı `<UYGULAMA_ADRESI>/#/masraflar/<id>` biçimindedir (yalnızca http/https adres kabul edilir). Maildeki tutar formun tutarı ve para birimidir. PDF'teki zamanlar sunucunun yerel saatiyle yazılır; düzeltilen faturalar `*` ile işaretlenir. `MAIL_GONDERIM=smtp` iken `SMTP_HOST` ve `MAIL_GONDEREN` zorunludur; giden kutusu işi yalnızca bu modda çalışır. Hatırlatma işi mail kapalıyken de çalışır (uygulama içi bildirim gider, mail `atlandi` yazılır).

| Olay | Alıcı | Tür | Mail eki |
|---|---|---|---|
| Gönderim (ilk `bekliyor` adım) ya da bir onaydan sonra sıradaki adım `bekliyor` oldu | O adımın onaycısı | `onay_bekliyor` | |
| Devret | Yeni onaycı (adım `bekliyor` ise `onay_bekliyor`, `sirada` ise bilgi olarak `devredildi`) | `onay_bekliyor` / `devredildi` | |
| Son onay (form `onaylandi`) | Form sahibi | `onaylandi` | Onay belgesi PDF |
| Son onay (form `onaylandi`) | Aktif `muhasebe` kullanıcıları | `odeme_bekliyor` | |
| Ret | Form sahibi (mesajda ret gerekçesi) | `reddedildi` | |
| Ödendi | Form sahibi | `odendi` | |
| Hatırlatma | `HATIRLATMA_BEKLEME_SAAT` saatten uzun `bekliyor` duran adımın onaycısı | `hatirlatma` | |
| Formun okunmayı bekleyen son faturası da sonuçlandı, hepsi okundu (okununca gönder kapalı) | Form sahibi | `okuma_bitti` | |
| Formun okunmayı bekleyen son faturası da sonuçlandı, okunamayan var | Form sahibi | `okuma_hatasi` | |
| Okununca gönder: form kendiliğinden onaya gönderildi | Form sahibi | `onaya_gonderildi` | |
| Okununca gönder: gönderim kontrollerinden biri tutmadı (mesajda sebebi) | Form sahibi | `onaya_gonderilemedi` | |

Arka plandaki okuma ve okununca gönder olaylarını yapan bir kullanıcı yoktur; bu bildirimler form sahibine de gider (okununca gönder sahibinin kendi isteğinin ardından denendiyse gitmez). Bu bildirimlerin mailinde tutar girilmemişse "Girilmedi" yazılır.

- **Giden kutusu:** Sunucu içindeki bir iş `bekliyor` mailleri SMTP ile gönderir. Başarısız mail artan aralıklarla (1, 5, 15, 60 dakika…) en çok `MAIL_DENEME_SAYISI` kez denenir, sonra `hata` olur. `MAIL_GONDERIM=kapali` iken mailler `atlandi` olarak yazılır ve hiç gönderilmez; sonradan açmak eski mailleri göndermez. SMTP şifresi ve mail gövdeleri hiçbir kayda yazılmaz.
- **Mail içeriği:** Düz metin ve HTML (bütün değerler HTML'e kaçışlı yazılır). Form başlığı, sahibi, tutarı ve durumu yazılır. `UYGULAMA_ADRESI` doluysa panelde formun bağlantısı eklenir. Fatura dosyaları eklenmez.
- **Onay belgesi (PDF):** Form numarası, başlık, sahip ve departman, kategori, masraf tarihi, tutar, para birimi, kur, onay tutarı. Faturalar tablosu (fatura no, tarih, satıcı, vergi no, genel toplam; düzeltilen faturalar işaretli). Son turun onay adımları (sıra, onaycı, karar, karar zamanı, açıklama, yedek). Belgenin oluşturulma zamanı. Türkçe karakterler için depodaki gömülü yazı tipi kullanılır. Aynı belge `GET /api/masraflar/:id/pdf` ile indirilir.
- **Hatırlatma:** Sunucu her gün `HATIRLATMA_SAATI`'nden (sunucunun yerel saati) sonra bir kez çalışır. `bekliyor` adımı `HATIRLATMA_BEKLEME_SAAT` saatten uzun beklemiş ve o gün hatırlatılmamış (`son_hatirlatma`) her onaycıya, adım başına bir bildirim ve mail gönderir. `HATIRLATMA_BEKLEME_SAAT=0` hatırlatmayı kapatır. Adımın bekleme süresi, formun gönderimi ile aynı turdaki son karardan hangisi daha yeniyse ondan sayılır; devretme bu süreyi sıfırlamaz.

## 8. Ayarlar (`.env`)

Bütün ayarlar kök dizindeki `.env` dosyasından okunur (`env.example` şablondur: `copy env.example .env`). Sunucu `node --env-file-if-exists=.env` ile başlar. `docker compose` de aynı dosyayı kullanır. Mobil uygulamanın ayarları `masraf-app/.env` içindedir (`EXPO_PUBLIC_*`).

## 9. Entegrasyonlar (SAP PI/PO)

Entegrasyon, onaylanan masraf formlarını dış bir sisteme (ör. SAP PI/PO'nun REST ya da HTTP adaptörü) gönderir. Yönetici panelde "Entegrasyonlar" sayfasından hangi form ve fiş alanlarının hangi adla (alias) gideceğini, gövdenin biçimini (JSON ya da XML) ve adresi seçer. Örneğin `Tutar` alanı `TTR` adıyla JSON gövdede `{"TTR": 2193.39}` olarak gider.

Birden çok entegrasyon tanımlanabilir (ör. test ve canlı PI). Her biri ayrı adres, biçim, alan eşlemesi ve gönderim zamanıyla çalışır.

### Gönderim zamanı ve kuyruk

- **Tetikleyici (`tetikleyici`):** `onaylandi` form son onayı alınca, `odendi` form ödendi işaretlenince, `elle` yalnızca yönetici istediğinde gönderir. Tetikleyiciye uyan her aktif entegrasyon için gönderim, işlemle **aynı transaction'da** kuyruğa yazılır; işlem geri alınırsa gönderim de oluşmaz.
- **Elle gönderim:** Yönetici `onaylandi` ya da `odendi` durumundaki bir formu herhangi bir entegrasyonla (pasif olsa da; deneme için) elle gönderebilir. Her elle gönderim yeni bir kayıttır.
- **Pasif entegrasyon** kendiliğinden yeni gönderim oluşturmaz. Kuyrukta bekleyen otomatik gönderimleri de gönderilmez; entegrasyon yeniden aktif olunca gider. Elle gönderimler pasif entegrasyonda da gider.
- **Gövde gönderim anında oluşur:** Formun o anki bilgisi ve entegrasyonun o anki eşlemesiyle hazırlanır. Böylece eşlemedeki bir hata düzeltilip gönderim yeniden denenebilir. Her denemenin gövdesi kayda yazılır.
- **Gönderim işi:** Sunucu içindeki bir iş kuyruktaki gönderimleri sırayla gönderir (15 sn'de bir; elle gönderim ve yeniden deneme hemen başlar). İki sunucu süreci aynı gönderimi iki kez yapmaz.
- **Sonuç:** `2xx` yanıt başarıdır (`gonderildi`). Yanıtın gövdesine bakılmaz. Bağlantı hatası, zaman aşımı, `408`, `429` ve `5xx` artan aralıklarla (1, 5, 15, 60 dakika…) en çok `ENTEGRASYON_DENEME_SAYISI` kez denenir, sonra `hata` olur. Diğer yanıtlar (`3xx`, `4xx`) yeniden denemeyle düzelmeyeceği için hemen `hata` olur. Yönlendirme (`3xx`) izlenmez.
- **Gövde hazırlanamazsa** (eşlemedeki bir kaynak alan silinmiş, Basic şifresi çözülemiyor) gönderim denenmeden `hata` olur.
- Yönetici `hata` durumundaki gönderimi yeniden deneyebilir: deneme sayısı sıfırlanır, gönderim hemen kuyruğa girer.
- Yanıtın ilk 2000 karakteri ve HTTP durum kodu kayda yazılır. Şifre ve `Authorization` başlığı hiçbir kayda, yanıta ya da hata mesajına yazılmaz.

### Gövde

Eşlemedeki her satır bir kaynak alanı (`kaynak`) bir ada (`alias`) bağlar. Kaynak ya form düzeyindedir (`form.*`, formda bir kez) ya da fiş düzeyindedir (`fis.*`, formdaki her fatura için). Satırların sırası gövdedeki sıradır. Önce form düzeyindeki alanlar, sonra fiş listesi yazılır. Hiç fiş düzeyinde satır yoksa fiş listesi yazılmaz.

JSON (`bicim: "json"`):

```jsonc
{
  "TTR": 2193.39,
  "BUKRS": "1000",
  "FISLER": [                       // fisListesi; faturasız formda []
    { "BELNR": "ABC2026000123", "BLDAT": "2026-11-05", "WRBTR": 1800 }
  ]
}
// kok doluysa (ör. "MASRAF") gövde { "MASRAF": { … } } olur.
```

XML (`bicim: "xml"`):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<ns0:MT_Masraf xmlns:ns0="urn:firma:masraf">
  <TTR>2193.39</TTR>
  <BUKRS>1000</BUKRS>
  <FISLER>
    <FIS>
      <BELNR>ABC2026000123</BELNR>
      <BLDAT>2026-11-05</BLDAT>
      <WRBTR>1800.00</WRBTR>
    </FIS>
  </FISLER>
</ns0:MT_Masraf>
<!-- xmlAdAlani boşsa kök öneksiz yazılır: <MT_Masraf>. Alt öğeler ad alanı almaz (SAP PI kuralı). -->
```

Değerler:

| Kaynak türü | JSON | XML |
|---|---|---|
| `metin` | metin | metin (`&`, `<`, `>`, `"`, `'` kaçışlı; XML'de geçersiz denetim karakterleri silinir) |
| `sayi` | sayı | sayının kendisi (`0.5`, `34.123456`) |
| `tutar` | sayı (`1800`, `2193.39`) | iki ondalıklı (`1800.00`) |
| `tarih` | `tarihBicimi`ne göre metin | aynı |
| boş değer | `null` | boş öğe (`<TTR/>`) |

- Ondalık ayracı her zaman noktadır, binlik ayracı yoktur.
- `tarihBicimi`: `YYYY-AA-GG` (varsayılan, `2026-11-05`), `YYYYAAGG` (`20261105`, SAP `DATS`), `GG.AA.YYYY` (`05.11.2026`). Zaman bilgisi olan kaynaklar (gönderim, onay, ödeme) sunucunun yerel tarihine çevrilir.
- Sabit değer (`form.sabit`, `fis.sabit`) her zaman metin olarak yazılır (ör. şirket kodu `1000`).
- Gövde girintili (2 boşluk) yazılır. JSON'da `Content-Type: application/json; charset=utf-8`, XML'de `application/xml; charset=utf-8` gönderilir; `basliklar` ile değiştirilebilir.

### Kaynak alanlar

Form düzeyi (`form.*`):

| Kaynak | Ad | Tür |
|---|---|---|
| `form.no` | Form No | sayi |
| `form.baslik` | Başlık | metin |
| `form.aciklama` | Açıklama | metin |
| `form.masrafTarihi` | Masraf Tarihi | tarih |
| `form.tutar` | Tutar | tutar |
| `form.paraBirimi` | Para Birimi | metin |
| `form.kur` | Kur | sayi |
| `form.yerelTutar` | Yerel Tutar | tutar |
| `form.onayTutari` | Onay Tutarı | tutar |
| `form.satici` | Satıcı | metin |
| `form.durum` | Durum | metin (`onaylandi`, `odendi`, …) |
| `form.kategori` | Kategori | metin (ad) |
| `form.kategoriKodu` | Kategori Kodu | metin |
| `form.hesapKodu` | Hesap Kodu | metin (kategorinin) |
| `form.masrafMerkezi` | Masraf Merkezi | metin (kod) |
| `form.masrafMerkeziAciklama` | Masraf Merkezi Açıklaması | metin |
| `form.organizasyon` | Organizasyon Kodu | metin |
| `form.organizasyonAdi` | Organizasyon Adı | metin |
| `form.gonderen` | Gönderen | metin (ad soyad) |
| `form.gonderenEposta` | Gönderen E-postası | metin |
| `form.departman` | Departman | metin (gönderenin) |
| `form.gonderimTarihi` | Gönderim Tarihi | tarih (son gönderim) |
| `form.onayTarihi` | Onay Tarihi | tarih (son onay) |
| `form.odemeTarihi` | Ödeme Tarihi | tarih |
| `form.sonOnaylayan` | Son Onaylayan | metin (son turda en son onaylayan) |
| `form.fisSayisi` | Fiş Sayısı | sayi |
| `form.sabit` | Sabit değer | metin (`deger`) |

Fiş düzeyi (`fis.*`, faturanın formdaki **geçerli bilgisi**, bölüm 3):

| Kaynak | Ad | Tür |
|---|---|---|
| `fis.sira` | Sıra | sayi (1, 2, …) |
| `fis.kimlik` | Fatura Kimliği | metin |
| `fis.dosyaAdi` | Dosya Adı | metin |
| `fis.faturaNo`, `fis.faturaTarihi`, `fis.saticiUnvan`, `fis.saticiVergiNo`, `fis.aliciUnvan`, `fis.aliciVergiNo`, `fis.paraBirimi` | Fatura bilgileri | metin (`faturaTarihi`: tarih) |
| `fis.araToplam`, `fis.kdvToplam`, `fis.genelToplam` | Fatura toplamları | tutar |
| `fis.yerelKarsilik` | Yerel Karşılık | tutar (gönderenin girdiği; yalnızca üçüncü para birimindeki faturada) |
| `fis.yerelTutar` | Yerel Tutar | tutar (faturanın 6. kuraldaki yerel değeri; sayılamıyorsa boş) |
| `fis.alan.<anahtar>` | Fiş alanının adı | `liste`: seçeneğin kodu (metin); `metin`, `uzun_metin`: metin; `sayi`: sayi; `tarih`: tarih |
| `fis.alan.<anahtar>.ad` | "<Alan adı> (açıklama)" | metin: seçeneğin adı (yalnızca `liste` alanları) |
| `fis.sabit` | Sabit değer | metin (`deger`) |

Pasif fiş alanı kaynak listesinde kalır (`aktif: false`), değeri boş gider. Silinen bir fiş alanına bağlı eşleme satırı entegrasyonun `sorunlar` listesinde görünür; o satır düzeltilene kadar gönderimler `hata` olur.

### Kurallar

- `ad` 1–80 karakterdir ve benzersizdir (büyük/küçük harf ayrımı yapılmaz).
- `adres` `http://` ya da `https://` ile başlayan, en çok 2000 karakterlik bir adrestir. Adreste kullanıcı adı ya da şifre olamaz (Basic kimlik doğrulaması kullanılır). Yerel ağdaki adresler kabul edilir.
- `yontem`: `POST` (varsayılan) ya da `PUT`. `zamanAsimiSn`: 5–120, varsayılan 30.
- **Ad kuralı** (`alias`, `kok`, `fisListesi`, `fisOgesi`): harf ya da `_` ile başlar; harf, rakam, `_`, `-` ve `.` içerir; en çok 60 karakterdir; `xml` ile başlayamaz (büyük/küçük harf fark etmez). Türkçe harf kullanılamaz. Böylece aynı eşleme JSON ve XML'de geçerlidir.
- `kok` XML'de zorunludur, JSON'da isteğe bağlıdır. `fisListesi` (varsayılan `FISLER`) ve `fisOgesi` (varsayılan `FIS`, yalnızca XML'de kullanılır) her zaman doludur.
- `xmlAdAlani` isteğe bağlıdır, en çok 400 karakterdir; boşluk, `"`, `'`, `<`, `>` ve `&` içeremez. Doluysa kök `ns0:` önekiyle yazılır.
- `alanlar` 1–100 satırdır. Form düzeyindeki adlar kendi aralarında ve `fisListesi` ile, fiş düzeyindeki adlar kendi aralarında benzersizdir (büyük/küçük harf ayrımı yapılmaz). Aynı kaynak farklı adlarla birden çok kez eşlenebilir. `deger` yalnızca sabit değer satırında bulunur ve zorunludur (1–200 karakter); diğer satırlarda gönderilirse `400` döner.
- `kimlik.tur`: `yok` ya da `basic`. Basic'te `kullanici` (1–200) zorunludur. `sifre` (en çok 500) yalnızca istekte gönderilir, hiçbir yanıtta dönmez; yanıtta `sifreVar` bulunur. `PUT` içinde `sifre` gönderilmezse (boş metin ya da `null` da gönderilmemiş sayılır) kayıtlı şifre korunur. İlk kez Basic seçilirken şifre zorunludur. `tur: "yok"` kullanıcı adını ve şifreyi siler.
- Şifre veritabanında `ENTEGRASYON_ANAHTARI` ile şifrelenmiş (AES-256-GCM) saklanır. Anahtar tanımlı değilken şifre kaydedilemez (`409 anahtar_yok`). Anahtar değişirse kayıtlı şifreler çözülemez; gönderim `hata` olur ve şifre yeniden girilmelidir.
- `basliklar` en çok 20 ek HTTP başlığıdır (`{ ad, deger }`). `ad` HTTP başlık adı kurallarına uyar; `Host`, `Content-Length`, `Authorization`, `Connection`, `Transfer-Encoding`, `Cookie` ve benzeri bağlantı başlıkları kullanılamaz. `deger` en çok 1000 karakterdir, satır sonu içeremez. Başlık değerleri gizli sayılmaz ve yanıtta döner; gizli değerler için Basic kimlik doğrulaması kullanılır.
- Ekleme, değişiklik, silme, elle gönderim ve yeniden deneme denetim kaydına yazılır (`entegrasyon_ekle`, `entegrasyon_guncelle`, `entegrasyon_sil`, `entegrasyon_gonder`, `entegrasyon_yeniden`). Şifre denetim kaydına yazılmaz; yalnızca "şifre değişti" yazılır.
- Entegrasyon silinince gönderim kaydı da silinir.

### API (yonetici)

| İstek | Gövde | Yanıt |
|---|---|---|
| `GET /api/entegrasyonlar` | | `Entegrasyon[]` (ada göre) |
| `GET /api/entegrasyonlar/kaynaklar` | | `{ form: Kaynak[], fis: Kaynak[] }` |
| `POST /api/entegrasyonlar` | `EntegrasyonGirdi` | `201 Entegrasyon` · `400 gecersiz_istek` · `409 entegrasyon_adi_kullaniliyor` · `409 anahtar_yok` |
| `GET /api/entegrasyonlar/:id` | | `Entegrasyon` |
| `PUT /api/entegrasyonlar/:id` | `EntegrasyonGirdi` (tamamı yerine geçer; `kimlik.sifre` gönderilmezse korunur) | `Entegrasyon` · `400` · `409 entegrasyon_adi_kullaniliyor` · `409 anahtar_yok` |
| `DELETE /api/entegrasyonlar/:id` | | `204` |
| `POST /api/entegrasyonlar/onizle` | `{ entegrasyon: EntegrasyonGirdi, formId? }` | `Onizleme` · `400` (girdi `alanlar["entegrasyon.<yol>"]` ile) · `404` (form yok) |
| `POST /api/entegrasyonlar/:id/gonder` | `{ formId }` | `202 { id }` (gönderim kaydının kimliği) · `404` · `409 gecersiz_durum` (form `onaylandi` ya da `odendi` değil) |
| `GET /api/entegrasyon-gonderimleri?entegrasyonId=&formId=&durum=&adet=50` | | `GonderimOzet[]` (en yeni önce; `adet` 1–500) |
| `GET /api/entegrasyon-gonderimleri/:id` | | `Gonderim` |
| `POST /api/entegrasyon-gonderimleri/:id/yeniden` | | `202` · `409 gecersiz_durum` (yalnızca `hata`) |

```jsonc
// EntegrasyonGirdi (POST/PUT gövdesi). Gönderilmeyen isteğe bağlı alanlar varsayılanını alır.
{ "ad": "SAP PI masraf", "aktif": true,                // aktif varsayılanı true
  "adres": "https://pi.firma.local:50001/RESTAdapter/masraf",
  "yontem": "POST",                                     // POST | PUT
  "bicim": "json",                                      // json | xml
  "kok": null, "xmlAdAlani": null,
  "fisListesi": "FISLER", "fisOgesi": "FIS",
  "tarihBicimi": "YYYY-AA-GG",                          // YYYY-AA-GG | YYYYAAGG | GG.AA.YYYY
  "tetikleyici": "onaylandi",                           // onaylandi | odendi | elle
  "kimlik": { "tur": "basic", "kullanici": "PIUSER", "sifre": "…" },   // varsayılanı { "tur": "yok" }
  "basliklar": [ { "ad": "X-Kaynak", "deger": "masraf" } ],           // varsayılanı []
  "zamanAsimiSn": 30,
  "alanlar": [
    { "kaynak": "form.tutar", "alias": "TTR" },
    { "kaynak": "form.sabit", "alias": "BUKRS", "deger": "1000" },
    { "kaynak": "fis.faturaNo", "alias": "BELNR" } ] }

// Entegrasyon: girdinin bütün alanları (varsayılanlar dolu), şifre hariç, ve şunlar:
{ "id": 1, …,
  "kimlik": { "tur": "basic", "kullanici": "PIUSER", "sifreVar": true },
  "sorunlar": [],          // ör. "3. satır (fis.alan.etiket): bu alan silinmiş." Doluyken gönderimler hata olur
  "sonGonderim": { "id": 41, "durum": "gonderildi", "zaman": "…" },   // en son gönderim kaydı; yoksa null
  "olusturma": "…", "guncelleme": "…", "guncelleyen": { "id": 1, "adSoyad": "…" } }   // guncelleyen null olabilir

// Kaynak
{ "anahtar": "form.tutar", "ad": "Tutar", "tur": "tutar", "aktif": true }   // tur: metin | sayi | tutar | tarih

// Onizleme: girdinin bu formla (formId yoksa örnek verilerle) üreteceği gövde. Hiçbir şey gönderilmez, kaydedilmez.
{ "govde": "{\n  \"TTR\": 2193.39\n}", "icerikTuru": "application/json; charset=utf-8",
  "ornek": false,          // true: formId verilmedi, örnek veriler kullanıldı
  "form": { "id": 1001, "baslik": "…" } }   // ornek iken null
// Önizleme yalnızca gövdeyi belirleyen alanları doğrular (bicim, kok, xmlAdAlani, fisListesi, fisOgesi, tarihBicimi,
// basliklar, alanlar); ad, adres, kimlik gibi diğerleri yok sayılır. Böylece kaydedilmemiş, yarım bir düzenleyici de
// önizlenir. icerikTuru, basliklar içinde Content-Type varsa odur. Önizleme her durumdaki formu gösterebilir.

// GonderimOzet
{ "id": 41, "entegrasyon": { "id": 1, "ad": "SAP PI masraf" }, "form": { "id": 1001, "baslik": "…" },
  "tetikleyen": "onaylandi",          // onaylandi | odendi | elle
  "kullanici": null,                  // elle gönderen yönetici (KisiOzet); otomatikte null
  "durum": "gonderildi",              // bekliyor | gonderildi | hata
  "deneme": 1, "httpDurum": 200,      // httpDurum: son denemenin yanıt kodu; yanıt alınamadıysa null
  "sonHata": null,                    // ör. "HTTP 500: …", "Bağlantı kurulamadı: ECONNREFUSED", "Zaman aşımı (30 sn)."
  "olusturma": "…", "gonderim": "…", "sonrakiDeneme": null }

// Gonderim = GonderimOzet + son denemenin gövdesi ve yanıtı
{ …, "govde": "…", "icerikTuru": "application/json; charset=utf-8",   // henüz denenmediyse ikisi de null
  "yanit": "…" }                                                         // yanıtın ilk 2000 karakteri; yoksa null
```
