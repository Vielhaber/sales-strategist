/**
 * All network access lives here. The Gemini API key never touches the
 * browser: it is entered once in Settings, sent to the local server via
 * POST /api/config, and stored server-side. From then on the frontend only
 * talks to our own /api/* endpoints, which is also what makes it possible
 * to test/mock the app without an API key.
 */

async function readJsonSafe(res) {
  try {
    return await res.json();
  } catch (_) {
    return {};
  }
}

/** Whether a Gemini key is currently configured on the server. */
export async function apiGetConfigStatus() {
  try {
    const res = await fetch("/api/config/status");
    if (!res.ok) return { configured: false };
    return await res.json();
  } catch (_) {
    return { configured: false };
  }
}

/** Persists a new Gemini API key server-side. */
export async function apiSaveConfig(apiKey) {
  const res = await fetch("/api/config", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ apiKey }),
  });
  const data = await readJsonSafe(res);
  if (!res.ok) throw new Error(data.error || `HTTP-Fehler ${res.status}`);
  return data;
}

/** Removes the stored Gemini API key server-side. */
export async function apiClearConfig() {
  const res = await fetch("/api/config/clear", { method: "POST" });
  return readJsonSafe(res);
}

/** Lists Gemini models usable with the currently configured key. */
export async function apiListModels() {
  const res = await fetch("/api/models");
  const data = await readJsonSafe(res);
  if (!res.ok) throw new Error(data.error || `HTTP-Fehler ${res.status}`);
  return data.models || [];
}

/**
 * Runs a single-shot Gemini generateContent call through the backend proxy.
 * Model fallback (e.g. to gemini-1.5-flash on failure) is handled server-side.
 */
export async function apiGenerate(prompt, model) {
  const res = await fetch("/api/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt, model }),
  });
  const data = await readJsonSafe(res);
  if (!res.ok) throw new Error(data.error || `HTTP-Fehler ${res.status}`);
  if (!data.text) throw new Error("Ungültige Antwort von der Gemini API erhalten.");
  return data.text;
}

/** Scrapes a product URL server-side (SSRF-guarded) and returns plain text. */
export async function apiScrape(url) {
  const res = await fetch(`/api/scrape?url=${encodeURIComponent(url)}`);
  if (!res.ok) return "";
  const data = await readJsonSafe(res);
  return data.text || "";
}

/**
 * Parses the Gemini response using the custom module markers
 */
export function parseGeminiResponse(rawText) {
  const data = {
    modules: {
      module1: "",
      module_fit: "",
      module2: "",
      module3: ""
    },
    emails: [],
    objections: [],
    followup: [],
    roi_defaults: {
      ek: 40,
      uvp: 99,
      monthly_qty: 300,
      pos_boost: 30,
      cross_selling: 10
    }
  };

  // Extract ROI defaults using Regex
  const roiMatch = rawText.match(/ROI_DEFAULTS:\s*ek=(\d+),\s*uvp=(\d+),\s*monthly_qty=(\d+),\s*pos_boost=(\d+),\s*cross_selling=(\d+)/);
  if (roiMatch) {
    data.roi_defaults.ek = parseInt(roiMatch[1]);
    data.roi_defaults.uvp = parseInt(roiMatch[2]);
    data.roi_defaults.monthly_qty = parseInt(roiMatch[3]);
    data.roi_defaults.pos_boost = parseInt(roiMatch[4]);
    data.roi_defaults.cross_selling = parseInt(roiMatch[5]);
  }

  // Split raw text based on module markers
  const sections = {};
  const markerRegex = /===(MODULE1|MODULE_FIT|MODULE2|MODULE3|EMAIL_A|EMAIL_B|EMAIL_C|QUESTIONS|OBJECTIONS|FOLLOWUP)===/g;

  let match;
  let lastIndex = 0;
  let lastKey = null;

  while ((match = markerRegex.exec(rawText)) !== null) {
    if (lastKey) {
      sections[lastKey] = rawText.substring(lastIndex, match.index).trim();
    }
    lastKey = match[1];
    lastIndex = markerRegex.lastIndex;
  }
  if (lastKey) {
    sections[lastKey] = rawText.substring(lastIndex).trim();
  }

  // Map basic text modules
  data.modules.module1 = sections["MODULE1"] || "Keine Daten.";
  data.modules.module_fit = sections["MODULE_FIT"] || "Keine Daten.";

  // Clean ROI_DEFAULTS line out of Module 2 if it's there
  let mod2Text = sections["MODULE2"] || "Keine Daten.";
  mod2Text = mod2Text.replace(/ROI_DEFAULTS:[^\n]+/g, "").trim();
  data.modules.module2 = mod2Text;

  data.modules.module3 = sections["MODULE3"] || "Keine Daten.";

  // Parse Option A, B, C Emails
  const parseEmail = (secKey, optLetter, defaultType) => {
    const text = sections[secKey];
    if (!text) return;

    const subjectMatch = text.match(/Betreff:\s*(.+)/i);
    const subject = subjectMatch ? subjectMatch[1].trim() : "Outreach-Kontakt";

    // Clean subject line out of body
    let body = text.replace(/Betreff:\s*.+/i, "").replace(/Option\s+[A-C]:[^\n]+/i, "").trim();

    data.emails.push({
      option: optLetter,
      type: defaultType,
      subject: subject,
      body: body
    });
  };

  parseEmail("EMAIL_A", "A", "Nutzen- & Problemfokus");
  parseEmail("EMAIL_B", "B", "Case Study / Social Proof");
  parseEmail("EMAIL_C", "C", "Soft Outreach / Beziehungsaufbau");

  // Questions and closing strategy will be prepended to Tab 5 content
  const questionsText = sections["QUESTIONS"] || "";

  // Parse Objections EINWAND: / KONTER:
  const objectionsText = sections["OBJECTIONS"] || "";
  const objectionRegex = /EINWAND:\s*(.+)\n+KONTER:\s*((?:(?!EINWAND:).|\n)+)/gi;
  let objMatch;

  while ((objMatch = objectionRegex.exec(objectionsText)) !== null) {
    data.objections.push({
      title: objMatch[1].trim(),
      content: objMatch[2].trim()
    });
  }

  // Parse Followup Timeline SCHRITT: / AKTION:
  const followupText = sections["FOLLOWUP"] || "";
  const followupRegex = /SCHRITT:\s*Tag\s*(\d+)\s*-\s*(.+)\n+AKTION:\s*((?:(?!SCHRITT:).|\n)+)/gi;
  let followMatch;

  while ((followMatch = followupRegex.exec(followupText)) !== null) {
    data.followup.push({
      day: `Tag ${followMatch[1]}`,
      title: followMatch[2].trim(),
      content: followMatch[3].trim()
    });
  }

  // Store raw questions text; rendering (with escaping) happens at display time
  data.questions_raw = questionsText;

  return data;
}

/**
 * Builds the main sales-strategist prompt sent to /api/generate.
 */
export function buildStrategistPrompt(industry, product, scrapedText) {
  let urlPromptText = "";
  if (scrapedText) {
    urlPromptText = `\n- ZUSÄTZLICHER WEBSITE-TEXT ZUM PRODUKT:\n\"\"\"\n${scrapedText}\n\"\"\"\nHINWEIS ZUM WEBSITE-TEXT: Bitte analysiere diesen live ausgelesenen Text des Produkts sehr genau. Nimm die exakten Features, Alleinstellungsmerkmale, Anwendungsbeispiele und das Nutzenversprechen als reale Faktenbasis für deine B2B-Bedarfsanalyse und das Vertriebskonzept.`;
  }

  return `Du bist die weltbeste KI-Vertriebsstrategin und B2B-Marktanalystin.
Deine Aufgabe ist es, für folgende Eingaben eine hochpräzise Bedarfsermittlung, eine Validierung der Markttauglichkeit und ein interaktives B2B-Verkaufskonzept (Sales Enablement Cockpit) zu entwickeln.

EINGABEDATEN:
- Branche / Zielmarkt: ${industry}
- Produkt / Dienstleistung / Portfolio: ${product}${urlPromptText}
- Geschäftsmodell: B2B
- Aktuelles Kalenderjahr der Suchanfrage: 2026. Alle gelieferten Daten, Marktprognosen, Branchenstatistiken und Kampagneninformationen müssen zwingend auf dem aktuellen Stand von 2026 (oder neuer) sein und dürfen keinesfalls älter als 2026 sein.

WICHTIGE ANWEISUNG:
Teile deine Antwort exakt in Abschnitte auf, die mit den Markern ===MODULE1===, ===MODULE_FIT===, ===MODULE2===, ===MODULE3===, ===EMAIL_A===, ===EMAIL_B===, ===EMAIL_C===, ===QUESTIONS===, ===OBJECTIONS=== und ===FOLLOWUP=== beginnen. Gib keinen Text vor dem ersten Marker aus. Verwende exakt diese Struktur im Markdown-Format:

===MODULE1===
### MODUL 1: BEDARFSERMITTLUNG & SCHMERZPUNKTE (PAIN POINTS)
* **Status Quo der Branche:** [Die 3 größten Herausforderungen / Engpässe dieser Branche mit Bulletpoints]
* **Problem-Markt-Fit:** [Welches konkrete, teure Problem löst das Produkt/die Dienstleistung bei der Zielgruppe?]
* **Triggermomente (Wann kauft der Kunde?):** [Welche Ereignisse lösen bei der Zielgruppe den akuten Bedarf aus?]

===MODULE_FIT===
### MODUL 2: PRODUKT-BRANCHEN-FIT (EIGNUNGS-ARGUMENTE)
[Liste 4-5 starke Argumente auf, warum dieses Produkt optimal zur Branche passt. Formatiere die Titel fett, z.B. * **Argument 1: [Titel]** \\n [Erklärung]]

===MODULE2===
### MODUL 3: BRAUCHBARKEIT & MARKTVALIDIERUNG (EVALUATION)
* **Brauchbarkeits-Score (1–10):** Wie hoch ist der unmittelbare Nutzwert des Produkts für diese Branche? (Schreibe genau 'Brauchbarkeits-Score: X / 10' mit einer Zahl X von 1 bis 10 und einer kurzen Begründung).
* **ROI- & Wert-Argumentation:** [Wie lässt sich der Nutzen in Geld, Zeitersparnis oder Risikominimierung ausdrücken?]

ROI_DEFAULTS: ek=[Empfohlener Einkaufspreis für das Händler-Produkt in Euro, z.B. 40], uvp=[Empfohlener Verkaufspreis/UVP für Endkunden in Euro, z.B. 99], monthly_qty=[Typische Absatzmenge eines Händlers pro Monat, z.B. 300], pos_boost=[Erwarteter Absatz-Steigerungs-Prozentsatz durch POS-Präsentation/Aufsteller, z.B. 30], cross_selling=[Typischer Zusatzumsatz durch Zubehör/Cross-Selling pro Kauf in Euro, z.B. 10]

===MODULE3===
### MODUL 4: STRATEGISCHES SALES- & GO-TO-MARKET-KONZEPT
* **Ideal Customer Profile (ICP):** [Wer genau ist der Entscheider (Rolle, Prioritäten, Motivationsfaktoren)?]
* **Positionierung / Hook:** [Ein knackiger 1-Satz-Pitch (Elevator Pitch) in Kursivschrift, der sofort Neugier weckt.]
* **Empfohlener Vertriebskanal:** [Welcher Vertriebsansatz funktioniert hier am besten?]

===EMAIL_A===
Option A: Nutzen- & Problemfokus
Betreff: [Eingängiger Betreff]
[Sehr kurzes Akquisitions-E-Mail-Template. Schreibe im Blockquote-Format (jede Zeile mit '>' beginnen). Nutze Platzhalter wie [Nachname], [Firmenname] und [Ihr Name]]

===EMAIL_B===
Option B: Case Study / Social Proof
Betreff: [Eingängiger Betreff]
[Sehr kurzes Kaltakquise-Template mit Fokus auf Glaubwürdigkeit/Case Study. Im Blockquote-Format (jede Zeile mit '>' beginnen). Nutze Platzhalter]

===EMAIL_C===
Option C: Soft Outreach / Beziehungsaufbau
Betreff: [Eingängiger Betreff]
[Sehr kurzes Kaltakquise-Template mit Fokus auf Feedback, Dialog oder Wissensaustausch. Im Blockquote-Format (jede Zeile mit '>' beginnen). Nutze Platzhalter]

===QUESTIONS===
#### 1. Leitfaden für das Erstgespräch (3 magische Fragen)
[3 magische Qualifizierungsfragen, die den Schmerz des Kunden sofort aufdecken.]

#### 2. Closing-Strategie
[Der effektivste Hebel, um den Sack im Verkaufsgespräch zuzumachen.]

===OBJECTIONS===
EINWAND: [Erster häufiger Einwand/Kaufblockade der Entscheider, z.B. Keine Zeit]
KONTER: [Schlagkräftige Antwort zur Entkräftung nach der LAER-Methode (Listen, Acknowledge, Explore, Respond)]
EINWAND: [Zweiter Einwand]
KONTER: [Antwort]
EINWAND: [Dritter Einwand]
KONTER: [Antwort]

===FOLLOWUP===
SCHRITT: Tag 3 - [Titel des ersten Nachfassens]
AKTION: [Kurze Beschreibung der Aktion & Template]
SCHRITT: Tag 7 - [Titel des zweiten Nachfassens]
AKTION: [Beschreibung & Template]
SCHRITT: Tag 14 - [Titel des dritten Nachfassens]
AKTION: [Beschreibung & Template]

Schreibe auf Deutsch. Keine einleitenden Floskeln, sondern direkt zum Inhalt.`;
}

/**
 * Builds the Lead-Scout prompt. `count` controls how many leads to request
 * (the small sidebar scout asks for 5-7, the main-page scout asks for 50+).
 */
export function buildLeadFinderPrompt(product, region, industry, minCount) {
  const countText = minCount >= 50 ? "mindestens 50" : "5 bis 7";
  return `
Du bist ein hochpräziser B2B-Sales-Scout. Recherchiere ${countText} reale oder hochgradig plausible Unternehmen in der Region "${region}", die als B2B-Kunden für folgendes Produkt in Frage kommen: "${product}".
${industry ? `Fokussiere dich vorrangig auf Unternehmen aus der Branche: "${industry}".` : ""}
Stelle sicher, dass alle recherchierten Unternehmen tatsächlich physisch in der gesuchten Region "${region}" ansässig sind.
Das aktuelle Kalenderjahr ist 2026. Alle gelieferten Informationen müssen zwingend auf dem aktuellen Stand von 2026 (oder neuer) sein.

Erstelle ein JSON-Array, das ausschließlich passende Firmenobjekte enthält. Jedes Objekt muss exakt diese Schlüssel besitzen:
- "company": Vollständiger Firmenname
- "contact": Ein passender Ansprechpartner (z. B. "Herr Schmidt (Einkaufsleiter)")
- "email": Eine B2B-Kontakt-E-Mail (z. B. info@firma.de)
- "phone": Eine plausible Telefonnummer mit der korrekten regionalen Vorwahl für die Region "${region}"
- "industry": Die genaue Branche des Unternehmens
- "website": Die Website (z. B. https://www.firma.de)
- "notes": Eine aussagekräftige Vertriebsnotiz, warum dieses Unternehmen das Produkt benötigt

Gib AUSSCHLIESSLICH das nackte JSON-Array zurück. Schreibe keine Erklärungen davor oder danach. Verwende keine Markdown-Codeblocks (\`\`\`json).
`;
}

/**
 * Builds the chat-assistant prompt.
 */
export function buildChatPrompt(industry, product, currentCampaignData, userQuery) {
  return `
Du bist die KI-Vertriebsassistentin OrbitAI. Der B2B-Sales-Manager nutzt deine App, um für folgende Eingaben Vertriebskonzepte zu erstellen:
- Zielbranche: ${industry || "Nicht definiert (allgemeine Anfrage)"}
- Produkt / Lösung: ${product || "Nicht definiert (allgemeine Anfrage)"}
- Aktuelles Kalenderjahr der Suchanfrage: 2026. Alle gelieferten Daten, Marktprognosen und Antworten müssen zwingend auf dem Stand von 2026 (oder neuer) sein und dürfen keinesfalls älter als 2026 sein.

Er hat diese Analyse vor sich liegen:
${JSON.stringify(currentCampaignData || "Noch keine Detail-Kampagnen geladen.")}

Er hat dir im Chat folgende Frage oder Anweisung gegeben:
"${userQuery}"

WICHTIGE AGENTEN-FUNKTION (SYSTEM-STEUERUNG):
Falls der Nutzer eine Systemaktion wünscht, füge am Ende deiner Textantwort EXAKT eine dieser Kommandozeilen in einer neuen Zeile hinzu (verwende echte Werte aus dem Chat-Kontext als Parameter, keine Variablen-Platzhalter!):
- [SYSTEM_COMMAND: analyze("Branche", "Produkt")] -> Um eine neue B2B-Bedarfsanalyse zu starten.
- [SYSTEM_COMMAND: scout("Produkt", "Region", "Branche")] -> Um Leads nach Produkt und Ort zu scouten.
- [SYSTEM_COMMAND: load_demo("predictive" | "logistics" | "recruiting")] -> Um eine Demo-Kampagne zu laden.
- [SYSTEM_COMMAND: switch_tab("module1" | "module_fit" | "module2" | "module3" | "module4" | "crm")] -> Um den Reiter im Cockpit umzuschalten.
- [SYSTEM_COMMAND: export_leads()] -> Um die CRM-Leads als CSV zu exportieren.
- [SYSTEM_COMMAND: open_setup()] -> Um das Setup zu öffnen.

Beantworte seine Frage, hilf ihm bei Ergänzungen oder erstelle auf Wunsch neue E-Mails oder Gegenargumente. Antworte in strukturierter Markdown-Form, halte dich kurz, präzise und lösungsorientiert.
`;
}

// --------------------------------------------------------------------------
// Offline / no-API-key mock generators (unchanged behaviour, moved as-is)
// --------------------------------------------------------------------------

export function generateLocalMockData(industry, product) {
  const cleanInd = industry || "deine Zielbranche";
  const cleanProd = product || "deine Lösung";

  return {
    modules: {
      module1: `### MODUL 1: BEDARFSERMITTLUNG & SCHMERZPUNKTE (PAIN POINTS)
* **Status Quo der Branche:** Spürbarer Kostendruck, Fachkräftemangel und die Notwendigkeit zur Prozess-Digitalisierung in der Branche **${cleanInd}**.
* **Problem-Markt-Fit:** Manuelle oder ineffiziente B2B-Abläufe kosten täglich wertvolle Margen. Die Einführung von **${cleanProd}** behebt diese Schwachstellen direkt.
* **Triggermomente (Wann kauft der Kunde?):** Anstehende Reorganisationsphasen, steigende Betriebskosten oder unzufriedene Endkunden wegen Verzögerungen.`,

      module_fit: `### PROBLEM-MARKT-FIT & POSITIONIERUNG
* **Wertversprechen:** **${cleanProd}** bietet eine sofort messbare Effizienzsteigerung und sichert die Wettbewerbsfähigkeit in der Branche **${cleanInd}**.
* **Alleinstellungsmerkmal (USP):** Schnelle Integration, intuitive Bedienung und ein unschlagbares B2B-Nutzenversprechen.`,

      module2: `### MODUL 2: B2B VERTRIEBS-PLAYBOOK & AKQUISITION
* **Elevator Pitch:** "Wir unterstützen B2B-Unternehmen aus der Branche ${cleanInd} dabei, mit ${cleanProd} ihre Betriebskosten signifikant zu senken und gleichzeitig die Durchlaufzeiten zu halbieren – komplett risikofrei."
* **Zielgruppe (Buyer Personas):** Geschäftsführer, Einkaufsleiter und Operations Manager, die unter erheblichem Leistungsdruck stehen.`,

      module3: `### MODUL 3: EINWAND-TRAINER & ARGUMENTATION
* **Einwand 1: "Wir haben kein Budget für ${cleanProd}."**
  * *Gegenargument:* "${cleanProd} amortisiert sich in der Regel bereits nach wenigen Monaten. Es ist keine Ausgabe, sondern eine Investition zur langfristigen Kostensenkung."
* **Einwand 2: "Das System ist uns zu komplex."**
  * *Gegenargument:* "Unsere Lösung ist für eine plug-and-play Einführung konzipiert. Wir schulen dein Team in unter 2 Stunden."`
    },
    emails: [
      {
        subject: `Effizienz-Upgrade für dein Unternehmen im Bereich ${cleanInd}`,
        body: `Hallo [Name],\n\nich sehe täglich, vor welchen Herausforderungen Unternehmen im Bereich ${cleanInd} aktuell stehen – insbesondere beim Margendruck.\n\nMit unserer B2B-Lösung **${cleanProd}** helfen wir Betrieben dabei, diese Reibungspunkte vollkommen zu eliminieren.\n\nWann passt es dir diese Woche für ein kurzes 5-Minuten-Telefonat?\n\nViele Grüße,\n[Absender]`
      },
      {
        subject: `Prozessoptimierung durch ${cleanProd}`,
        body: `Hallo [Name],\n\nich melde mich noch einmal kurz bezüglich **${cleanProd}**.\n\nViele B2B-Betriebe in der Region haben durch die Umstellung ihre Betriebskosten um bis zu 25% gesenkt.\n\nLass uns kurz abstimmen, ob das auch für dich Sinn macht.\n\nBeste Grüße,\n[Absender]`
      },
      {
        subject: `Letzter Versuch: Potenzialanalyse für [Unternehmen]`,
        body: `Hallo [Name],\n\nda ich dich telefonisch nicht erreichen konnte, hier mein letzter Versuch.\n\nWenn die Senkung von Durchlaufzeiten in der Branche ${cleanInd} für dich aktuell kein Thema ist, antworte mir einfach kurz mit 'Nein'.\n\nAndernfalls freue ich mich auf ein kurzes Kennenlernen.\n\nHerzliche Grüße,\n[Absender]`
      }
    ],
    objections: [
      {
        objection: `Das Produkt ${cleanProd} ist uns zu teuer.`,
        response: "Ich verstehe die Bedenken. Aber lass uns den ROI betrachten: Bei einer Marge von X amortisiert sich das Produkt in nur wenigen Wochen. Danach erzielst du puren Zusatzgewinn."
      },
      {
        objection: "Wir arbeiten bereits mit einem anderen Partner.",
        response: `Das ist gut, das zeigt, dass ihr das Thema ernst nehmt. Unsere Kunden schätzen an uns jedoch die spezialisierte Ausrichtung auf ${cleanInd}, die oft signifikante Mehrwerte liefert.`
      }
    ],
    followup: [
      { phase: "Tag 1", action: "Erstkontakt per E-Mail (Vorteile anteasern)" },
      { phase: "Tag 3", action: "Telefonischer Nachfass / Terminvereinbarung" },
      { phase: "Tag 7", action: "Zweite E-Mail mit konkretem ROI-Rechenbeispiel" },
      { phase: "Tag 14", action: "Abschluss-Nachricht (Break-up Mail)" }
    ],
    roi_defaults: {
      ek: 45,
      uvp: 99,
      monthly_qty: 250,
      pos_boost: 25,
      cross_selling: 12
    }
  };
}

// --------------------------------------------------------------------------
// Landing page generator
// --------------------------------------------------------------------------

const LP_STYLE_GUIDANCE = {
  "modern-minimal": "Modern und minimalistisch: viel Weißraum, ein Akzentfarbton (z.B. Indigo/Blau), klare serifenlose Typografie (System-Fonts), dezente Schatten, abgerundete Ecken.",
  "corporate": "Seriös und corporate: gedeckte Farben (Navy, Grau, ein dezenter Blauton), klare Struktur, vertrauenswürdig wirkend, wenig Spielerei, gut lesbare Absätze.",
  "bold": "Verspielt und auffällig: kräftiger Farbverlauf (z.B. Lila/Pink oder Orange/Rot), große Headlines, verspielte Icons/Emojis, viel visuelle Energie, aber trotzdem gut lesbar.",
  "dark-premium": "Dunkel und premium: fast schwarzer Hintergrund, ein edler Akzent (Gold, Cyan oder Violett), hoher Kontrast, hochwertige/minimalistische Icons, Premium-Anmutung.",
};

/**
 * Builds the prompt sent to /api/generate for the landing page generator.
 * Instructs the model to return ONE self-contained HTML document (inline
 * CSS + vanilla JS only, no external dependencies) so the result can be
 * dropped straight into a GitHub Pages repo as index.html.
 */
export function buildLandingPagePrompt({ productName, style, cta, prompt }) {
  const styleGuidance = LP_STYLE_GUIDANCE[style] || LP_STYLE_GUIDANCE["modern-minimal"];
  const name = productName || "das Produkt";
  const ctaText = cta || "Jetzt starten";

  return `Du bist eine erfahrene Webdesignerin und Frontend-Entwicklerin. Baue eine hochprofessionelle, vollständig funktionsfähige One-Page-Landingpage.

PRODUKT / FIRMA: ${name}
DESIGN-STIL: ${styleGuidance}
HAUPT-CALL-TO-ACTION-TEXT: "${ctaText}"

BESCHREIBUNG / ANFORDERUNGEN DES NUTZERS:
"""
${prompt || "Erstelle eine überzeugende, generische B2B-SaaS-Landingpage mit Hero-Bereich, Feature-Übersicht, Social Proof und einer klaren Handlungsaufforderung."}
"""

HARTE TECHNISCHE ANFORDERUNGEN (unbedingt einhalten):
1. Gib AUSSCHLIESSLICH ein einziges, vollständiges HTML-Dokument zurück, beginnend mit <!DOCTYPE html> und endend mit </html>. Kein Text davor oder danach, keine Markdown-Codeblock-Marker (\`\`\`).
2. Alles muss in dieser einen Datei enthalten sein: CSS in einem <style>-Tag im <head>, JavaScript (falls nötig, z.B. für ein mobiles Menü oder sanftes Scrollen) in einem <script>-Tag vor </body>. Keine externen Stylesheets, Frameworks oder CDN-Links (kein Tailwind-CDN, kein Bootstrap, keine Google Fonts-Links) - nutze ausschließlich Systemschriften.
3. Die Seite muss vollständig responsive sein (Mobile, Tablet, Desktop) mit sauberem CSS (Flexbox/Grid, KEINE externen Bilder/Icon-Fonts - falls Icons gewünscht sind, nutze einfache Inline-SVGs oder Unicode-Symbole/Emojis).
4. Struktur: Navigation mit Logo/Produktname, Hero-Sektion mit Headline, Subheadline und einem auffälligen CTA-Button ("${ctaText}"), 3-4 Feature-/Vorteils-Boxen, ein Abschnitt mit sozialem Beweis (z.B. ein Testimonial-Zitat oder Kennzahlen), ein abschließender CTA-Bereich, und ein schlichter Footer.
5. Nutze semantisches HTML (header, main, section, footer), sinnvolle Überschriften-Hierarchie und ausreichend Farbkontrast für Barrierefreiheit.
6. Alle Buttons/Links dürfen auf "#" oder Anker innerhalb der Seite verweisen, da dies eine eigenständige Demo-Seite ist.
7. Schreibe alle sichtbaren Texte auf Deutsch, professionell und überzeugend, passend zur Beschreibung oben.`;
}

/**
 * Extracts a clean HTML document from a raw model response: strips markdown
 * code fences if present and trims anything before <!DOCTYPE/<html> or after
 * </html>, so stray commentary from the model doesn't break the page.
 */
export function extractHtmlFromResponse(rawText) {
  let text = (rawText || "").trim();

  // Strip ``` / ```html fences if the model added them anyway
  text = text.replace(/^```(?:html)?\s*/i, "").replace(/```\s*$/i, "").trim();

  const startMatch = text.match(/<!DOCTYPE html>|<html[\s>]/i);
  const start = startMatch ? startMatch.index : 0;

  const endMatch = text.match(/<\/html\s*>/i);
  const end = endMatch ? endMatch.index + endMatch[0].length : text.length;

  const extracted = text.substring(start, end).trim();

  if (!extracted || !/<html[\s>]/i.test(extracted)) {
    // Fallback: wrap whatever we got so the preview never shows a blank/broken frame
    return `<!DOCTYPE html><html lang="de"><head><meta charset="UTF-8"><title>Fehler</title></head><body style="font-family: sans-serif; padding: 2rem; color: #333;"><h2>Die KI-Antwort konnte nicht als HTML-Seite erkannt werden.</h2><pre style="white-space: pre-wrap; background: #f5f5f5; padding: 1rem; border-radius: 6px;">${text.replace(/</g, "&lt;")}</pre></body></html>`;
  }

  return extracted;
}

const LP_MOCK_PALETTES = {
  "modern-minimal": { bg: "#ffffff", text: "#1a1a2e", accent: "#4f46e5", accentText: "#ffffff", muted: "#6b7280", surface: "#f5f6fb" },
  "corporate": { bg: "#ffffff", text: "#1f2937", accent: "#1d4ed8", accentText: "#ffffff", muted: "#4b5563", surface: "#f1f5f9" },
  "bold": { bg: "#1a0b2e", text: "#ffffff", accent: "#ec4899", accentText: "#ffffff", muted: "#d1c4e9", surface: "#2a1250" },
  "dark-premium": { bg: "#0a0a0a", text: "#f5f5f5", accent: "#d4af37", accentText: "#0a0a0a", muted: "#a3a3a3", surface: "#151515" },
};

/**
 * Offline fallback: builds a complete, self-contained landing page HTML
 * document locally (no API key needed) using the same inputs, so the
 * feature always produces something usable.
 */
export function generateLocalMockLandingPage({ productName, style, cta, prompt }) {
  const palette = LP_MOCK_PALETTES[style] || LP_MOCK_PALETTES["modern-minimal"];
  const name = productName || "Dein Produkt";
  const ctaText = cta || "Jetzt starten";
  const description = (prompt || "").trim();
  const subheadline = description
    ? description.split(/[.\n]/)[0].trim().substring(0, 140)
    : "Die smarte Lösung für dein Team - schneller, einfacher, effizienter.";

  const features = [
    { title: "Schnell startklar", text: "In wenigen Minuten eingerichtet, ohne komplizierte Konfiguration." },
    { title: "Made for Teams", text: "Gebaut für den täglichen Einsatz - intuitiv für dein ganzes Team." },
    { title: "Messbare Ergebnisse", text: "Transparente Kennzahlen, die den Mehrwert sofort sichtbar machen." },
  ];

  return `<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${name}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background: ${palette.bg}; color: ${palette.text}; line-height: 1.6; }
  a { color: inherit; }
  .container { max-width: 1100px; margin: 0 auto; padding: 0 1.5rem; }
  header { display: flex; justify-content: space-between; align-items: center; padding: 1.25rem 0; }
  header .logo { font-weight: 700; font-size: 1.2rem; }
  nav a { margin-left: 1.5rem; text-decoration: none; color: ${palette.muted}; font-size: 0.9rem; }
  .btn { display: inline-block; background: ${palette.accent}; color: ${palette.accentText}; padding: 0.85rem 1.75rem; border-radius: 8px; text-decoration: none; font-weight: 600; border: none; cursor: pointer; font-size: 1rem; }
  .hero { text-align: center; padding: 5rem 0 4rem; }
  .hero h1 { font-size: clamp(2rem, 5vw, 3.2rem); font-weight: 800; margin-bottom: 1.25rem; }
  .hero p { font-size: 1.15rem; color: ${palette.muted}; max-width: 640px; margin: 0 auto 2rem; }
  .features { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 1.5rem; padding: 3rem 0; }
  .feature-card { background: ${palette.surface}; border-radius: 12px; padding: 1.75rem; }
  .feature-card h3 { margin-bottom: 0.5rem; font-size: 1.1rem; }
  .feature-card p { color: ${palette.muted}; font-size: 0.95rem; }
  .testimonial { text-align: center; padding: 4rem 1.5rem; background: ${palette.surface}; margin: 2rem 0; border-radius: 16px; }
  .testimonial blockquote { font-size: 1.3rem; font-style: italic; max-width: 640px; margin: 0 auto 1rem; }
  .testimonial cite { color: ${palette.muted}; font-size: 0.9rem; }
  .cta-section { text-align: center; padding: 4rem 0; }
  .cta-section h2 { font-size: 1.8rem; margin-bottom: 1.5rem; }
  footer { text-align: center; padding: 2rem 0; color: ${palette.muted}; font-size: 0.85rem; border-top: 1px solid rgba(128,128,128,0.2); }
  @media (max-width: 600px) { nav { display: none; } }
</style>
</head>
<body>
  <div class="container">
    <header>
      <div class="logo">${name}</div>
      <nav>
        <a href="#features">Funktionen</a>
        <a href="#testimonial">Referenzen</a>
        <a href="#cta">Kontakt</a>
      </nav>
    </header>

    <section class="hero">
      <h1>${name}</h1>
      <p>${subheadline}</p>
      <a class="btn" href="#cta">${ctaText}</a>
    </section>

    <section class="features" id="features">
      ${features.map(f => `<div class="feature-card"><h3>${f.title}</h3><p>${f.text}</p></div>`).join("\n      ")}
    </section>

    <section class="testimonial" id="testimonial">
      <blockquote>"Seit wir ${name} einsetzen, sparen wir jede Woche mehrere Stunden Arbeit."</blockquote>
      <cite>- Zufriedene Kundin</cite>
    </section>

    <section class="cta-section" id="cta">
      <h2>Bereit loszulegen?</h2>
      <a class="btn" href="#">${ctaText}</a>
    </section>

    <footer>
      &copy; ${new Date().getFullYear()} ${name}. Alle Rechte vorbehalten. (Offline-Demo-Vorschau)
    </footer>
  </div>
</body>
</html>`;
}

export function generateLocalMockLeads(product, region, industry) {
  const cleanProd = product || "Lösung";
  const cleanReg = region || "deine Region";
  const cleanInd = industry || "B2B";
  const regCap = cleanReg.charAt(0).toUpperCase() + cleanReg.slice(1);

  const companies = [
    "Müller", "Schmidt", "Schneider", "Fischer", "Weber", "Meyer", "Wagner", "Becker", "Schulz", "Hoffmann",
    "Schäfer", "Koch", "Bauer", "Richter", "Klein", "Wolf", "Schröder", "Neumann", "Schwarz", "Zimmermann",
    "Tech", "Industrie", "Vertrieb", "Handel", "Dienstleistung", "Zukunft", "Logistik", "Digital", "Global", "Systems",
    "Kreativ", "Projekt", "Consulting", "Finance", "Energy", "Solutions", "Concept", "Group", "Partner", "Network",
    "Hub", "Lab", "Works", "Mind", "Flow", "Core", "Prime", "Elite", "Nexus", "Apex"
  ];

  const suffixes = ["GmbH", "AG", "KG", "GmbH & Co. KG", "e.U.", "Holding", "Group"];

  const firstNames = [
    "Michael", "Andreas", "Thomas", "Stefan", "Christian", "Martin", "Daniel", "Peter", "Alexander", "David",
    "Sabine", "Petra", "Maria", "Andrea", "Anna", "Christina", "Julia", "Katharina", "Sandra", "Karin"
  ];

  const lastNames = [
    "Gruber", "Hofer", "Wallner", "Lang", "Müller", "Bauer", "Wagner", "Huber", "Pichler", "Steiner",
    "Mayer", "Berger", "Wimmer", "Eder", "Fuchs", "Leitner", "Schmid", "Winkler", "Schwarz", "Reiter"
  ];

  const positions = [
    "Geschäftsführer", "Inhaber", "Einkaufsleiter", "Leiter IT & Prozesse", "Vertriebsleitung",
    "Digital Transformation Officer", "Technical Director", "Operations Manager", "Head of Business Development", "CFO"
  ];

  const domains = [
    "at", "de", "ch", "com", "net", "org"
  ];

  const notesTemplates = [
    `Großer Bedarf an ${cleanProd} zur Margenoptimierung und Digitalisierung vor Ort.`,
    `Sucht aktiv nach neuen Lösungen wie ${cleanProd} zur Effizienzsteigerung des Teams.`,
    `Traditionelles Unternehmen, das durch ${cleanProd} wettbewerbsfähig bleiben möchte.`,
    `Ideal als Innovationspartner für die Einführung von ${cleanProd}.`,
    `Möchte ${cleanProd} nutzen, um B2B-Vertriebsprozesse in der Region zu beschleunigen.`,
    `Planung für Budgetierung von ${cleanProd} im nächsten Quartal läuft bereits.`,
    `Zeigt Interesse an einer Prozessoptimierung durch ${cleanProd} zur Kostenreduktion.`,
    `Möchte die interne Infrastruktur mit ${cleanProd} modernisieren.`
  ];

  const mockLeads = [];

  for (let i = 1; i <= 50; i++) {
    const compName = companies[i % companies.length];
    const secondPart = companies[(i + 7) % companies.length];
    const suffix = suffixes[i % suffixes.length];
    const firstName = firstNames[i % firstNames.length];
    const lastName = lastNames[i % lastNames.length];
    const pos = positions[i % positions.length];
    const dom = domains[i % domains.length];
    const notes = notesTemplates[i % notesTemplates.length];

    const email = `${firstName.toLowerCase().charAt(0)}.${lastName.toLowerCase()}@${compName.toLowerCase()}-${cleanReg.toLowerCase()}.${dom}`;
    const website = `https://www.${compName.toLowerCase()}-${cleanReg.toLowerCase()}.${dom}`;

    // Region-based phone prefixes
    let phonePrefix = "+49";
    let areaCode = "30";

    const regLower = cleanReg.toLowerCase();
    if (regLower.includes("wien") || regLower.includes("steyr") || regLower.includes("linz") || regLower.includes("salzburg") || regLower.includes("graz") || regLower.includes("österreich") || regLower.includes("austria") || regLower.includes("tirol") || regLower.includes("innsbruck") || regLower.includes("kärnten")) {
      phonePrefix = "+43";
      if (regLower.includes("wien")) areaCode = "1";
      else if (regLower.includes("linz")) areaCode = "732";
      else if (regLower.includes("salzburg")) areaCode = "662";
      else if (regLower.includes("graz")) areaCode = "316";
      else if (regLower.includes("steyr")) areaCode = "7252";
      else areaCode = "664";
    } else if (regLower.includes("zürich") || regLower.includes("bern") || regLower.includes("genf") || regLower.includes("schweiz") || regLower.includes("switzerland") || regLower.includes("basel")) {
      phonePrefix = "+41";
      if (regLower.includes("zürich")) areaCode = "44";
      else if (regLower.includes("bern")) areaCode = "31";
      else if (regLower.includes("genf")) areaCode = "22";
      else areaCode = "79";
    } else {
      phonePrefix = "+49";
      if (regLower.includes("münchen")) areaCode = "89";
      else if (regLower.includes("hamburg")) areaCode = "40";
      else if (regLower.includes("köln")) areaCode = "221";
      else if (regLower.includes("frankfurt")) areaCode = "69";
      else if (regLower.includes("stuttgart")) areaCode = "711";
      else if (regLower.includes("düsseldorf")) areaCode = "211";
      else areaCode = "170";
    }

    const numSequence = (1234567 + (i * 98765)) % 10000000;
    const phone = `${phonePrefix} ${areaCode} ${numSequence}`;

    let finalComp = "";
    if (i % 3 === 0) {
      finalComp = `${compName} & ${secondPart} ${regCap} ${suffix}`;
    } else if (i % 3 === 1) {
      finalComp = `${regCap}er ${compName} ${suffix}`;
    } else {
      finalComp = `${compName} ${regCap} ${suffix}`;
    }

    mockLeads.push({
      company: finalComp,
      contact: `${firstName} ${lastName} (${pos})`,
      email: email,
      phone: phone,
      industry: i % 4 === 0 ? "Dienstleistungen" : (i % 4 === 1 ? "Technologie" : (i % 4 === 2 ? "Handel" : cleanInd)),
      website: website,
      notes: notes
    });
  }

  return mockLeads;
}
