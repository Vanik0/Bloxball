# BloxScore

Webova aplikace ve stylu Livesportu s verejnou casti (pouze cteni) a admin sekci pro upravy.

## Co umi
- Live prehled zapasu
- Hracske profily
- Seznam klubu
- Prestupy
- Sprava soutezi (admin)
- Klubovy login a klubovy panel
- Admin dashboard pro CRUD operace nad kluby, hraci, prestupy a zapasy

## Spusteni
1. `npm install`
2. `npm start`
3. Otevri `http://localhost:3000`

## Admin prihlaseni
- URL: `/admin/login`
- Uzivatel: `admin`
- Heslo: `admin123`

Admin udaje upravis v souboru `.env`.

## Klubovy login
- URL: `/club/login`
- Prihlasovaci jmeno/heslo nastavuje admin u konkretniho klubu v admin panelu.
