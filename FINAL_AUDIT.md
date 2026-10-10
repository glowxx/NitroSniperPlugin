# Końcowy audyt NitroSniperPlugin — 2026-10-04

Audyt wykonano zgodnie z `using-agent-skills` i `code-review-and-quality`. Sprawdzono aktualną wersję w `/workspace/NitroSniperPlugin-main`, testy regresyjne, ścieżki klienta/native, kolejkę DM, komendy bota, SQLite, anulowanie i konfigurację CI. Kod projektu ani gotowa paczka nie zostały zmienione.

## Wynik: jedna potwierdzona poprawka o średnim znaczeniu

### Odłączenie nie jest atomowe przy błędzie zapisu SQLite

Miejsce: `bot/service.mjs`, linie 112–116, `disconnect()`.

Usunięcie klucza z `links` oraz anulowanie zdarzeń w `events` są wykonywane jako osobne zatwierdzane zapisy. Jeśli usunięcie klucza się powiedzie, ale drugi zapis zawiedzie, konto pozostaje odłączone, a stare powiadomienia nadal mają stan `queued`. Ponowne połączenie konta pozwala workerowi je wysłać. Wyjątek pomija również wywołanie `controller.abort()` z linii 116. Komenda zgłasza ogólny błąd; nie potwierdza wtedy udanego odłączenia.

Reprodukcja: test `/tmp/ns-last-service-probe.mjs` wstrzykuje błąd drugiego zapisu przez trigger SQLite `RAISE(ABORT)`. Następnie sprawdza `linked=false` i `queued`, usuwa awarię, ponownie łączy konto i uruchamia dostarczenie. Stary event zostaje wysłany i otrzymuje stan `delivered`. Test przeszedł 1/1, potwierdzając niepożądane zachowanie. Trigger jest mechanizmem wstrzykiwania awarii, nie istniejącym elementem produkcyjnej bazy.

Zalecana poprawka: objąć usunięcie klucza i anulowanie kolejki jedną transakcją SQLite, z rollback przy błędzie. Zapewnić przerwanie trwającego requestu również na ścieżce błędu. Przy nieudanej transakcji zgłosić jednoznacznie, że odłączenie nie zostało wykonane i trzeba je ponowić. Dodać regresję dla awarii drugiego zapisu, spójności stanu oraz późniejszego relink. Nie przedstawiać nieudanej operacji jako skutecznego cofnięcia zgody.

## Weryfikacja

- Ponownie uruchomiono 47 istniejących testów: service 11, commands 5, audit-races 7, native 2, notification-recovery 5, plugin 17. Wszystkie przeszły na Node.js 24.19.0. Test HTTP wymagał uprawnienia do lokalnego nasłuchiwania; początkowe `listen EPERM` pochodziło z sandboxa.
- Osobny test wstrzykiwania awarii odtworzył opisany brak atomowości. Istniejące testy nie obejmują tego scenariusza.
- Mutacja w kopii `/tmp`, usuwająca ochronę `state='queued'` przy końcowym zapisie workera, została wykryta przez istniejącą regresję odłączenia podczas dostarczania. Źródła projektu pozostały nietknięte.
- Sumy plików przed i po audycie są identyczne. Wszystkie 48 plików paczki `NitroSniperPlugin-fixed-v2.zip` odpowiadają aktualnym plikom projektu. SHA-256 paczki: `b0d73341d371eb1b5dc9da48e766a0fe48d540718aacfaf206075c6ca1102256`.
- Poprzednia weryfikacja pełnych 119 testów na Node.js 24.19.0 i 22.13.0 oraz buildów Vencord/Equicord pozostaje wcześniejszym wynikiem. W tym audycie nie powtarzano całego zestawu ani buildów.

## Pozostałe obserwacje

Hipotezę o zapisie account-wide failure przez worker po utracie lease odrzucono jako niepotwierdzony błąd produkcyjny: uproszczony sender pozwalał go odtworzyć, ale produkcyjny `createDMSender()` ponownie sprawdza zgodę/własność w obsłudze błędu i blokuje tę ścieżkę.

Workflow używa pnpm 11.9.0 dla obu klientów, podczas gdy przypięty Equicord deklaruje 12.6.0 i lokalny build był sprawdzony na 12.6.0. Corepack przy jawnym wywołaniu 11.9.0 wypisuje ostrzeżenie i nie przełącza wersji. Warto dopasować wersję w macierzy CI do każdego klienta, aby CI odtwarzało lokalne warunki. Nie potwierdzono awarii builda z tego powodu; próbę instalacji w kopii `/tmp` przerwano po blokadzie pobierania metadanych przez sandbox. Nie jest to drugie potwierdzone ustalenie funkcjonalne.

Nie potwierdzono dalszych wymaganych zmian w sprawdzonych ścieżkach autoryzacji, limitów, batch/relink, komend, outboxa i filtrowania wiadomości. Rzeczywiste claimy, CAPTCHA i doręczenie DM na Discordzie pozostają niesprawdzone bez zalogowanego klienta i danych operatora bota. Audyt nie gwarantuje braku wszystkich możliwych błędów.
