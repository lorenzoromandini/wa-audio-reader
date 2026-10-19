# Audio → Testo per WhatsApp Web

Estensione Firefox che **trascrive i messaggi vocali di WhatsApp Web**: sotto ogni vocale compare un pulsante «Trascrivi» e il testo appare direttamente nella chat, **senza mai riprodurre l'audio**.

Perfetta quando non puoi (o non vuoi) ascoltare: ufficio, riunioni, ambiente rumoroso.

![Estensione: pulsante sotto i vocali, testo nella chat](icons/icon-128.png)

## Cosa fa

- Aggiunge il pulsante **«Trascrivi»** sotto ogni messaggio vocale (ricevuto o inviato).
- Il vocale **non viene riprodotto**: l'estensione blocca l'audio prima che parta e ne legge solo i byte.
- Mostra la trascrizione nella bolla, con **Copia**, **Rigenera** (nuova trascrizione) e «Nascondi/Mostra testo».
- Le trascrizioni sono **salvate in locale** e riusate: ogni vocale viene trascritto una sola volta.
- **Trascrizione automatica** (opzionale, spenta di default): i vocali ricevuti che compaiono sullo schermo vengono trascritti da soli.
- Funziona con **Groq** (consigliato, piano gratuito), **OpenAI** o un **server locale OpenAI-compatibile** (l'audio non lascia il PC).

## Requisiti

- Firefox 142 o successivo (desktop).
- Un servizio di trascrizione tra quelli supportati.
- Un account WhatsApp Web funzionante (l'estensione legge solo i vocali già visibili nella chat aperta).

## Installazione

### Prova rapida (sessione temporanea)

1. Apri `about:debugging#/runtime/this-firefox`.
2. Premi **«Carica componente temporaneo…»** e scegli il file `manifest.json` di questa cartella.
3. Apri [web.whatsapp.com](https://web.whatsapp.com): sotto i vocali comparirà «Trascrivi».

L'installazione temporanea sparisce quando chiudi Firefox: ideale per provare, non per l'uso quotidiano.

### Con web-ext (consigliato per lo sviluppo)

```powershell
npx web-ext run --source-dir .
```

### Installazione permanente

Firefox normale installa solo estensioni firmate. Per uso personale puoi:

1. Creare il pacchetto: `npx web-ext build --overwrite-dest --ignore-files "build/**" "test/**" "tools/**"` (zip in `web-ext-artifacts/`).
2. Oppure usare Firefox Developer Edition / Nightly con `xpinstall.signatures.required = false` in `about:config` e caricare il file `.zip` da `about:addons` → ingranaggio → «Installa componente da file…».

## Configurazione

Apri le **impostazioni** (dal popup in alto a destra o da `about:addons` → dettagli) e scegli il servizio:

### Groq (consigliato)

1. Crea una chiave su [console.groq.com/keys](https://console.groq.com/keys) (piano gratuito con limiti generosi).
2. Incollala nel campo **Chiave API**.
3. Modello predefinito: `whisper-large-v3-turbo` — molto veloce.

### OpenAI

1. Chiave da [platform.openai.com/api-keys](https://platform.openai.com/api-keys).
2. Modello predefinito: `gpt-4o-mini-transcribe` (qualità alta, pochi centesimi per vocale).

### Server locale / personalizzato (privacy massima)

Scegli «Server locale / personalizzato» e indica l'URL, ad esempio:

**Speaches** (ex faster-whisper-server, OpenAI-compatibile):

```powershell
docker run --rm -p 8000:8000 ghcr.io/speaches-ai/speaches:latest-cpu
```

URL del server: `http://localhost:8000/v1` — modello: `Systran/faster-whisper-small` (o `medium`).

**whisper.cpp** (`whisper-server`, con rotta OpenAI):

```powershell
whisper-server -m ggml-large-v3-turbo.bin --host 127.0.0.1 --port 8080 `
  --request-path /v1/audio/transcriptions --inference-path ""
```

URL del server: `http://127.0.0.1:8080/v1`.

Note:

- Va bene sia l'URL completo (`http://localhost:8000/v1/audio/transcriptions`) sia la sola base (`http://localhost:8000/v1`): il percorso `/audio/transcriptions` viene aggiunto in automatico.
- La prima volta che salvi o verifichi un endpoint personalizzato, Firefox chiede il permesso per quell'indirizzo.
- La chiave API può restare vuota per i server locali che non la richiedono.

### Altre opzioni

- **Lingua parlata**: indicarla migliora la precisione; «Rileva automaticamente» per audio misti.
- **Contesto per il modello**: nomi propri, sigle, termini tecnici ricorrenti.
- **Verifica connessione**: invia mezzo secondo di silenzio al servizio per controllare che tutto funzioni (utile, costo praticamente nullo).
- **Trascrizione automatica**: trascrive da solo i vocali ricevuti visibili sullo schermo (consuma credito API senza che tu clicchi).
- **Trascrizioni salvate**: da qui (o dal popup) puoi cancellare la cache (massimo 600 trascrizioni).

## Privacy

- L'audio viene inviato **solo** al servizio che scegli tu, **solo** quando premi «Trascrivi» (o in modalità automatica, se attiva). Nessun altro dato esce dal browser.
- Chiave API e trascrizioni sono salvate in `storage.local`, dentro il tuo profilo Firefox. Nessuna sincronizzazione, nessun analytics.
- Con il server locale l'audio non lascia il computer.
- ⚠️ Per trascrivere, WhatsApp deve scaricare il vocale: l'estensione preme il suo pulsante di riproduzione **ma blocca il suono prima che parta**. Il messaggio può comunque risultare «riprodotto» (doppia spunta blu) per il mittente.

## Come funziona (in breve)

WhatsApp Web non mette l'audio dei vocali nel DOM: la decrittazione avviene in un worker separato e i byte finiscono in un `new Audio()` mai agganciato al documento. L'unico punto che scatta sempre è `HTMLMediaElement.prototype.play()`.

1. `src/page-hook.js` (mondo pagina, a `document_start`) aggancia `play()`: quando una cattura è «armata», legge l'URL `blob:` dell'audio, ne copia i byte e restituisce una promise già risolta — **il suono non parte mai** (l'elemento viene anche ammutolito e messo in pausa per sicurezza).
2. `src/content.js` trova i vocali, disegna il pulsante, preme il play di WhatsApp al posto tuo e riceve i byte.
3. `src/background.js` invia l'audio al servizio scelto (evita i vincoli CORS/CSP della pagina) e restituisce il testo.
4. Il testo viene mostrato nella chat e salvato in cache per la prossima volta.

## Problemi comuni

| Problema | Soluzione |
| --- | --- |
| «Il componente pagina non è attivo» | L'estensione è stata aggiornata: ricarica WhatsApp Web con `Ctrl+Maiusc+R`. |
| «WhatsApp non ha completato il download» | Il vocale non è mai stato aperto: premi tu il play una volta, aspetta che finisca lo scaricamento e riprova. |
| Il pulsante «Trascrivi» non compare | Verifica di essere su `web.whatsapp.com` con una chat aperta. Se hai appena ricaricato senza successo, ricarica con `Ctrl+Maiusc+R`. Se Whatsapp ha cambiato l'interfaccia, potrebbe servire un aggiornamento dell'estensione. |
| «Chiave API rifiutata» (401/403) | Controlla la chiave nelle impostazioni e che il provider selezionato sia quello giusto. |
| «Endpoint non trovato» (404) | Controlla l'URL del server: va bene anche la sola base, il percorso viene completato da solo. |
| «Troppe richieste» (429) | Limite del servizio raggiunto: riprova fra qualche secondo. |
| Trascrizione sempre vuota | Audio molto corto, rumoroso o con parlato sovrapposto: «Rigenera» o cambia modello. |

## Limiti

- Solo Firefox desktop e WhatsApp Web (niente app desktop/mobile).
- Il vocale deve essere scaricabile da WhatsApp; l'audio non viene mai riprodotto ma il messaggio può risultare «riprodotto» al mittente.
- Circa 25 MB per vocale (oltre il limite del servizio scelto).
- La qualità della trascrizione dipende dal servizio e dall'audio (musica di sottofondo, voci sovrapposte, audio scadente = errori).
- WhatsApp Web cambia spesso: i selettori usati per riconoscere i vocali possono richiedere aggiornamenti.

## Sviluppo e test

Il progetto non ha dipendenze per l'estensione (solo strumenti di sviluppo via `npx`).

```powershell
# Test unitari e d'integrazione (Node >= 20)
node --test tools/test-core.mjs

# Build di sviluppo con la pagina finta di WhatsApp
node tools/dev-build.mjs
node test/mock-server.mjs        # in un altro terminale
npx web-ext run --source-dir build/dev --start-url http://localhost:8787/test/mock-whatsapp.html

# Test end-to-end (Firefox headless, pagina finta + server finto)
powershell -ExecutionPolicy Bypass -File tools/e2e-test.ps1

# Controllo qualità del manifest (test/ e build/ non fanno parte del pacchetto)
npx web-ext lint --ignore-files "build/**" "test/**"

# Rigenera le icone
powershell -ExecutionPolicy Bypass -File tools/make-icons.ps1
```

### Struttura

```
manifest.json            Manifest MV3 (Firefox)
src/
  page-hook.js           Hook su play() nel mondo della pagina (blocca l'audio e lo cattura)
  content.js             Riconoscimento vocali, pulsante «Trascrivi», UI, cache
  content.css            Stili del pulsante e della trascrizione (chiaro/scuro)
  background.js          Chiamata al servizio di trascrizione
  shared/core.js         Impostazioni, provider, utilità (testabile da Node)
  options/               Pagina impostazioni
  popup/                 Popup della barra degli strumenti
icons/                   Icone generate
test/
  mock-whatsapp.html     Pagina finta di WhatsApp per i test (4 chat: 3 vocali + 1 testo)
  mock-server.mjs        Finto servizio OpenAI-compatibile + server della pagina + esito test
  dev-autoconfig.js      Preconfigurazione per le build di sviluppo
tools/
  dev-build.mjs          Costruisce build/dev/ con la pagina finta
  e2e-test.ps1           Test end-to-end headless (build → server → Firefox → risultato)
  test-core.mjs          Test unitari/integrazione (node --test)
  make-icons.ps1         Generatore icone
```

## Stato

- Test unitari: 10/10 ✔
- `web-ext lint` (escludendo `test/` e `build/`): 0 errori, 0 avvisi ✔
- Test end-to-end (headless): 3 vocali rilevati, 0 falsi positivi, download automatico e rigenerazione ✔ (eseguito due volte, stabile)

Verificato con Firefox 158 su WhatsApp Web (luglio 2026).
