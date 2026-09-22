/* Padronizador Becker — transformação de DOCX/OOXML no navegador. */
(function () {
  "use strict";

  const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
  const R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
  const REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships";
  const CT_NS = "http://schemas.openxmlformats.org/package/2006/content-types";
  const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  const TYPES = [
    ["enderecamento", "Endereçamento"], ["identificacao", "Identificação"],
    ["titulo", "Título"], ["capitulo", "Capítulo"], ["subcapitulo", "Subcapítulo"],
    ["corpo", "Corpo"], ["citacao", "Citação"], ["figura", "Figura"],
    ["legenda", "Legenda"], ["pedidos", "Pedidos"], ["fechamento", "Fechamento"],
    ["data", "Data / local"], ["assinatura", "Assinatura"], ["tabela", "Tabela"],
    ["espaco", "Espaço"], ["outro", "Outro / conferir"]
  ];
  const TYPE_LABELS = Object.fromEntries(TYPES);

  /* Fonte única dos modelos: a seleção aponta para esta configuração. */
  const MODEL_CONFIGS = Object.freeze({
    simples: Object.freeze({
      id: "simples", label: "Peça simples", base: "REVISONAL PJ ENGECON",
      summary: "Matriz textual Becker completa: corpo Calibri 12, citação 10, faixa azul nos capítulos.",
      rules: { quoteIndent: 3402, quoteSize: 20, quoteFont: "Calibri" }
    }),
    bipartida: Object.freeze({
      id: "bipartida", label: "Peça bipartida", base: "REVISONAL PJ ENGECON",
      summary: "Mesma matriz textual da peça simples, com quebra de página obrigatória após a assinatura.",
      rules: {
        quoteIndent: 3402, quoteSize: 20, quoteFont: "Calibri",
        pageBreakAfterSignature: true
      }
    })
  });

  const state = {
    modelId: "simples", matrixFile: null, petitionFile: null,
    matrixZip: null, petitionZip: null, petitionXml: null,
    items: [], analyzed: false, busy: false, detailedReview: false, matrixEmbedded: false
  };
  const $ = (id) => document.getElementById(id);
  const bodyChildren = (doc) => {
    const body = Array.from(doc.getElementsByTagNameNS(W_NS, "body"))[0];
    return body ? Array.from(body.childNodes).filter((node) => node.nodeType === 1) : [];
  };
  const local = (node, name) => node && node.localName === name;
  const descendants = (node, name) => node ? Array.from(node.getElementsByTagNameNS(W_NS, name)) : [];
  const attr = (node, namespace, name) => node && node.getAttributeNS(namespace, name);
  const setAttr = (node, namespace, name, value) => node.setAttributeNS(namespace, "w:" + name, String(value));
  const esc = (value) => {
    const div = document.createElement("div");
    div.textContent = value == null ? "" : String(value);
    return div.innerHTML;
  };
  const norm = (value) => String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase().replace(/\s+/g, " ").trim();
  const cleanFileName = (value) => (String(value || "Padronizado-Becker").replace(/\.docx$/i, "").replace(/[^\wÀ-ÿ -]/g, "").trim() || "Padronizado-Becker") + ".docx";
  const setText = (id, value) => { if ($(id)) $(id).textContent = value; };

  function init() {
    document.querySelectorAll('input[name="model"]').forEach((input) => input.addEventListener("change", () => {
      state.modelId = input.value;
      updateModelUI();
      if (state.analyzed) renderPreview();
    }));
    bindUpload("matrix");
    bindUpload("petition");
    $("analyze-btn").addEventListener("click", analyze);
    $("back-btn").addEventListener("click", resetAnalysis);
    $("confirm-review").addEventListener("change", updateGenerateButton);
    if ($("detailed-review")) $("detailed-review").addEventListener("change", (event) => {
      state.detailedReview = event.target.checked;
      renderPreview();
    });
    $("generate-btn").addEventListener("click", generate);
    updateModelUI();
    loadFixedMatrix();
    updateFlow("Aguardando a petição", "O timbre Becker já está embutido. Envie apenas a petição DOCX.", 4);
  }

  // Carrega o timbre/matriz Becker embutido no app (matriz.docx ao lado da página),
  // para o usuário só precisar enviar a petição.
  async function loadFixedMatrix() {
    try {
      const response = await fetch("matriz.docx", { cache: "force-cache" });
      if (!response.ok) throw new Error("timbre não encontrado");
      const file = new File([await response.blob()], "Timbre-Becker.docx", { type: DOCX_MIME });
      const zip = await loadDocx(file);
      state.matrixFile = file; state.matrixZip = zip; state.matrixEmbedded = true;
      updateFileObservations();
      updateAnalyzeEnabled();
    } catch (error) {
      // Plano B: revela o upload manual da matriz.
      const card = $("matrix-card"); if (card) card.classList.remove("is-hidden");
      const note = $("matrix-fixed-note"); if (note) note.classList.add("is-hidden");
      updateFlow("Envie a matriz e a petição", "Não consegui carregar o timbre embutido; envie a matriz Becker manualmente.", 4);
    }
  }

  function updateAnalyzeEnabled() {
    const ready = state.matrixFile && state.petitionFile;
    $("analyze-btn").disabled = !ready || state.busy;
    if (ready) updateFlow("Pronto para identificar", "Clique em Analisar estrutura para identificar os blocos da petição.", 30);
    else if (state.matrixFile && !state.petitionFile) updateFlow("Aguardando a petição", "O timbre Becker já está embutido. Envie apenas a petição DOCX.", 8);
  }

  function bindUpload(kind) {
    const input = $(`${kind}-file`);
    const card = input.closest(".upload-card");
    input.addEventListener("change", (event) => handleFile(event.target.files[0], kind));
    ["dragenter", "dragover"].forEach((eventName) => {
      card.addEventListener(eventName, (event) => {
        event.preventDefault();
        event.stopPropagation();
        card.classList.add("is-dragging");
      });
    });
    ["dragleave", "drop"].forEach((eventName) => {
      card.addEventListener(eventName, (event) => {
        event.preventDefault();
        event.stopPropagation();
        card.classList.remove("is-dragging");
      });
    });
    card.addEventListener("drop", (event) => {
      const file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
      if (file) handleFile(file, kind);
    });
  }

  function updateModelUI() {
    const config = MODEL_CONFIGS[state.modelId];
    document.querySelectorAll("[data-model-card]").forEach((card) => card.classList.toggle("selected", card.dataset.modelCard === state.modelId));
    setText("model-rule-summary", config.summary);
    const rules = $("rules-list");
    if (state.modelId === "bipartida") {
      rules.innerHTML = "<li><span>01</span><span>Aplica toda a matriz textual Becker por tipo de bloco (corpo, capítulo, citação, pedidos…).</span></li><li><span>02</span><span>Cabeçalho, rodapé, imagens e estilos vêm da matriz carregada.</span></li><li><span>03</span><span>Quebra de página obrigatória logo após a assinatura.</span></li>";
    } else {
      rules.innerHTML = "<li><span>01</span><span>Corpo Calibri 12 (1ª linha 6 cm); citação Calibri 10; capítulos em faixa azul.</span></li><li><span>02</span><span>Cabeçalho, rodapé, imagens e estilos vêm da matriz carregada.</span></li><li><span>03</span><span>Blocos ambíguos ficam visíveis para conferência manual.</span></li>";
    }
  }

  async function handleFile(file, kind) {
    if (!file) return;
    const inputId = kind === "matrix" ? "matrix-file" : "petition-file";
    const statusId = kind === "matrix" ? "matrix-status" : "petition-status";
    try {
      if (!/\.docx$/i.test(file.name)) throw new Error("Selecione um arquivo DOCX válido.");
      const zip = await loadDocx(file);
      if (kind === "matrix") {
        state.matrixFile = file; state.matrixZip = zip;
      } else {
        state.petitionFile = file; state.petitionZip = zip;
      }
      $(inputId).closest(".upload-card").classList.add("has-file");
      setText(statusId, file.name);
      updateFileObservations();
      updateAnalyzeEnabled();
    } catch (error) {
      $(inputId).value = "";
      showFileError(error.message || "Não foi possível ler este DOCX.");
    }
  }

  async function loadDocx(file) {
    if (!window.JSZip) throw new Error("A biblioteca de leitura DOCX não carregou. Atualize a página e tente novamente.");
    const zip = await JSZip.loadAsync(await file.arrayBuffer());
    if (!zip.file("word/document.xml")) throw new Error("O arquivo não contém word/document.xml e não parece ser um DOCX utilizável.");
    const contentTypes = zip.file("[Content_Types].xml");
    if (!contentTypes) throw new Error("O pacote DOCX está incompleto: [Content_Types].xml não foi encontrado.");
    return zip;
  }

  function updateFileObservations() {
    const parts = [];
    // Se o timbre é o embutido, não anuncia nada sobre a matriz na página.
    if (state.matrixZip && !state.matrixEmbedded) {
      const names = Object.keys(state.matrixZip.files);
      const media = names.filter((name) => /^word\/media\//.test(name)).length;
      const headers = names.filter((name) => /^word\/header\d+\.xml$/.test(name)).length;
      const footers = names.filter((name) => /^word\/footer\d+\.xml$/.test(name)).length;
      parts.push(`<span class="file-observation"><b>Matriz reconhecida</b> · ${headers} cabeçalho(s), ${footers} rodapé(s), ${media} imagem(ns) preservada(s)</span>`);
    }
    if (state.petitionZip) parts.push(`<span class="file-observation"><b>Petição reconhecida</b> · pacote OOXML pronto para análise</span>`);
    $("file-observations").innerHTML = parts.join("");
  }

  function showFileError(message) {
    const observation = $("file-observations");
    observation.innerHTML = `<div class="notice error">${esc(message)} O arquivo anterior, se houver, continua disponível.</div>`;
  }

  async function analyze() {
    if (!state.petitionZip || !state.matrixZip || state.busy) return;
    setBusy(true);
    try {
      updateFlow("Lendo estrutura", "Extraindo parágrafos, tabelas, imagens e propriedades OOXML…", 27);
      const xml = await state.petitionZip.file("word/document.xml").async("string");
      const doc = parseXml(xml);
      const children = bodyChildren(doc).filter((node) => ["p", "tbl", "sdt", "altChunk"].includes(node.localName));
      if (!children.length) throw new Error("Nenhum parágrafo ou tabela foi encontrado no corpo da petição.");
      state.petitionXml = xml;
      state.items = classifyItems(children);
      state.analyzed = true;
      updateFlow("Estrutura identificada", "Confira as classificações e os textos antes de gerar.", 55);
      renderPreview();
      $("review-panel").classList.remove("is-hidden");
      $("generate-panel").classList.remove("is-hidden");
      $("confirm-review").checked = false;
      $("confirm-review").disabled = false;
      setActiveSteps(3);
      updateGenerateButton();
      $("review-panel").scrollIntoView({ behavior: "smooth", block: "start" });
    } catch (error) {
      showNotice("generation-result", error.message || "Não foi possível identificar o documento.", "error");
      $("generation-result").classList.remove("is-hidden");
      updateFlow("Não foi possível identificar", "Corrija o arquivo ou carregue outro DOCX para tentar novamente.", 12);
    } finally {
      setBusy(false);
    }
  }

  function parseXml(xml) {
    const doc = new DOMParser().parseFromString(xml, "application/xml");
    if (doc.getElementsByTagName("parsererror").length) throw new Error("O XML interno do DOCX está inválido ou corrompido.");
    return doc;
  }

  function inlineText(node) {
    if (!node) return "";
    if (node.nodeType === 3) return node.nodeValue || "";
    if (node.nodeType !== 1) return "";
    if (["t", "instrText"].includes(node.localName)) return node.textContent || "";
    if (node.localName === "tab") return "\t";
    if (["br", "cr"].includes(node.localName)) return "\n";
    return Array.from(node.childNodes).map(inlineText).join("");
  }
  function paragraphText(node) {
    return inlineText(node);
  }
  function hasDrawing(node) {
    return ["drawing", "pict", "object"].some((name) => descendants(node, name).length > 0);
  }
  function paragraphProps(node) {
    const pPr = descendants(node, "pPr")[0];
    const ind = pPr && descendants(pPr, "ind")[0];
    const spacing = pPr && descendants(pPr, "spacing")[0];
    return {
      left: Number(attr(ind, W_NS, "left") || 0),
      before: Number(attr(spacing, W_NS, "before") || 0),
      after: Number(attr(spacing, W_NS, "after") || 0),
      style: attr(descendants(pPr, "pStyle")[0], W_NS, "val") || ""
    };
  }
  function tableText(node) {
    return Array.from(node.getElementsByTagNameNS(W_NS, "tr")).map((row) =>
      Array.from(row.getElementsByTagNameNS(W_NS, "tc")).map((cell) => paragraphText(cell).trim()).filter(Boolean).join(" | ")
    ).filter(Boolean).join("\n");
  }
  function makeItem(node, index) {
    const isTable = local(node, "tbl");
    const text = isTable ? tableText(node) : paragraphText(node);
    return {
      index, node, originalText: text, text, kind: isTable ? "tabela" : "outro",
      confidence: 0, reason: "", needsReview: false, hasImage: !isTable && hasDrawing(node),
      props: isTable ? {} : paragraphProps(node), quoteGroup: null
    };
  }

  const STRUCTURAL_KINDS = new Set([
    "enderecamento", "identificacao", "titulo", "capitulo", "subcapitulo",
    "pedidos", "fechamento", "data", "assinatura", "figura", "legenda", "tabela"
  ]);
  // --- marcadores (em forma normalizada: MAIÚSCULAS, sem acento) ---
  const CNJ = /\d{7}[-\s]?\d{2}\.\d{4}\.\d\.\d{2}\.\d{4}/;
  const PARTES = /^(?:AUTOR(?:ES|A|AS)?|REU|RÉU|REQUERENTE(?:S)?|REQUERID[OA](?:S)?|EXEQUENTE(?:S)?|EXECUTAD[OA](?:S)?|APELANTE(?:S)?|APELAD[OA](?:S)?|EMBARGANTE(?:S)?|EMBARGAD[OA](?:S)?|AGRAVANTE(?:S)?|AGRAVAD[OA](?:S)?|RECORRENTE(?:S)?|RECORRID[OA](?:S)?)\s*:/;
  const DATE_RE = /(?:JANEIRO|FEVEREIRO|MARCO|MARÇO|ABRIL|MAIO|JUNHO|JULHO|AGOSTO|SETEMBRO|OUTUBRO|NOVEMBRO|DEZEMBRO)\s+DE\s+\d{4}/;
  const DATE_NUM = /\b\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4}\b/;
  const OAB_RE = /OAB(?:\/|\\|-)?[A-Z]{0,3}\s*[\d.]+/;
  const FECHO_RE = /^(?:TERMOS?\s+EM\s+QUE|(?:NESSE|NESSES|NESTE|NESTES)\s+TERMOS?|PEDE(?:-SE)?\s+(?:E\s+ESPERA\s+)?DEFERIMENTO|P\.?\s*DEFERIMENTO|SEM\s+MAIS|E\s+O\s+QUE\s+(?:SE\s+)?REQUER)/;
  const VOCATIVE = /^(?:EGREGIO|COLENDA|COLENDO|EMINENTE|EMINENTES|EXCELSA|EXCELSO|VENERAND|NOBRE\s+JULGADOR|DOUTO)/;

  function looksLikeSignatureName(text) {
    const value = String(text || "").trim();
    const normalized = norm(value)
      .replace(/^(?:DR|DRA|PROF|PROFA)\.?\s+/, "")
      .replace(/^(?:ADVOGAD[OA]|PROCURADOR[A]?)\s*:\s*/, "")
      .trim();
    const words = normalized.split(/\s+/).filter(Boolean);
    if (words.length < 2 || words.length > 7 || value.length > 110) return false;
    if (/\d|[:;!?]/.test(value)) return false;
    if (/(?:TERMOS|DEFERIMENTO|REQUER|PEDIDO|ATENCIOS|RESPEITOS|SUBSCREVO|EXCELENCIA|MERITISSIM)/.test(normalized)) return false;
    return words.every((word) => /^[A-ZÀ-Ü'’.-]+$/.test(word));
  }

  function looksLikeSectionTitle(n) {
    return /^(?:[IVXLCDM]+(?:\.[IVXLCDM]+)?[\s.)\-–]+|\d+(?:\.\d+)*[\s.)\-–]+|(?:CAPITULO|SECAO|TITULO)\b)/.test(n)
      || /^(?:DOS|DAS|DO|DA|DE)\s+[A-ZÀ-Ü][A-ZÀ-Ü\s-]{2,}$/.test(n);
  }
  function isNumberedSub(n) {
    return /^\d+(?:\.\d+)+[\s.)\-–]/.test(n) || /^[IVXLCDM]+\.[IVXLCDM]+[\s.)\-–]/.test(n);
  }

  // Detecção EXIGENTE de citação (evita bater em "acórdão", "STJ" soltos no texto).
  // Retorna força 0 (não é citação) .. .9. `n` é o texto normalizado (CAIXA, sem acento).
  function citationSignal(text, n, uppercaseRatio) {
    if (/^\(?\s*["“”«»]/.test(text.trim())) return .9;                       // começa com aspas
    if (/\bSUMULA\s+N?º?\.?\s*\d+/.test(n)) return .9;                        // "Súmula 539/STJ"
    if (/\((?:STJ|STF|TJ[A-Z-]{0,4}|TRF\d?)\b/.test(n)) return .9;            // "(STJ - REsp:..."
    if (/\b(?:STJ|STF|TJSC|TJ-SC|TRF\d?)\s*[-–,]\s*(?:RESP|ARESP|AGRG|AGINT|APCIV|APELACAO|EMBARGOS|RECURSO|AGRAVO)\b/.test(n)) return .9;
    if (/(?:TRANSCREVE-SE|TRANSCREVO|IN\s+VERBIS|\bVERBIS\b|EIS\s+O\s+TEOR|AD\s+LITTERAM|CONFORME\s+EMENTA)/.test(n)) return .85;
    if (uppercaseRatio > .55 && text.length > 130 && /(?:RECURSO\s+ESPECIAL|APELACAO(?:\s+CIVEL)?|EMBARGOS|DIREITO\s+CIVIL|PROCESSUAL\s+CIVIL|AGRAVO|DECISAO\s+MONOCRATICA)/.test(n)) return .85;
    return 0;
  }

  function classifyItems(nodes) {
    const items = nodes.map(makeItem);

    items.forEach((item, index) => {
      if (item.kind === "tabela") { item.confidence = .98; item.reason = "Tabela preservada como bloco estruturado."; return; }
      const text = item.text.trim();
      const n = norm(text);
      if (!text) { item.kind = "espaco"; item.confidence = .99; item.reason = "Parágrafo vazio preservado para manter a ordem."; return; }

      const scores = {}; const reasons = {};
      const score = (type, points, reason) => { scores[type] = (scores[type] || 0) + points; reasons[type] = reasons[type] ? `${reasons[type]} ${reason}` : reason; };
      const isFirst = index < Math.max(4, items.length * .12);
      const isLast = index >= Math.max(items.length - 5, items.length * .82);
      const letters = text.replace(/[^A-Za-zÀ-ÿ]/g, "");
      const uppercaseRatio = letters.length ? letters.replace(/[a-zà-ÿ]/g, "").length / letters.length : 0;
      const indented = item.props.left >= 1400;
      const isCNJ = CNJ.test(n);
      const isListItem = /^[a-z]\)\s/.test(text.trim());
      const isVocative = VOCATIVE.test(n) && text.length < 60;

      if (item.hasImage) score("figura", .98, "imagem ou desenho encontrado no XML");
      if (looksLikeCaption(text)) score("legenda", .9, "marcador de legenda");

      // Endereçamento
      if (/^(AO|AOS|A|À|AS)\s+(JUIZO|JUÍZO|TRIBUNAL|VARA|PRESIDENTE|ILUSTRISSIMO|ILUSTRÍSSIMO|EXCELENTISSIMO|EXCELENTÍSSIMO|SENHOR)/.test(n) || /^(EXCELENTISSIMO|EXCELENTÍSSIMO|ILUSTRISSIMO|ILUSTRÍSSIMO)\b/.test(n)) score("enderecamento", .92, "padrão de endereçamento no início da peça");
      if (isFirst && text.length < 120 && /(?:COMARCA|FORO|JUIZADO|TRIBUNAL|VARA|JUÍZO|JUIZO)/.test(n)) score("enderecamento", .6, "órgão jurisdicional em posição inicial");

      // Identificação / partes / qualificação
      if (PARTES.test(n)) score("identificacao", .82, "rótulo de parte (autor/réu/apelante…)");
      // Só as LINHAS CURTAS de qualificação (rótulos) contam como identificação;
      // o preâmbulo ("Fulano, já qualificado, vem respeitosamente… apresentar") é
      // um parágrafo longo e deve ser tratado como CORPO (com 1ª linha de 6 cm).
      if (!isListItem && text.length < 120 && /(?:JA\s+QUALIFICAD|JÁ\s+QUALIFICAD|INSCRIT[OA]\s+NA\s+OAB|\bCPF\b|\bCNPJ\b|RESIDENTE\s+E\s+DOMICILIAD)/.test(n)) score("identificacao", .85, "marcador de qualificação ou representação");
      if (isCNJ && text.length < 90) score("identificacao", .75, "linha de número de processo (CNJ)");
      if (isFirst && text.length < 120 && /(?:AUTOR|REU|RÉU|REQUERENTE|REQUERIDO|APELANTE|APELADO|PARTE)/.test(n) && !PARTES.test(n)) score("identificacao", .5, "partes em posição inicial");

      // Item de lista (a/b/c…) → pedido/enumeração, nunca capítulo
      if (isListItem) score("pedidos", .7, "item de lista de pedidos/enumeração (a, b, c…)");

      // Capítulo / subcapítulo (títulos de seção)
      if (!isListItem && looksLikeSectionTitle(n) && !isNumberedSub(n)) score("capitulo", .85, "marcador de capítulo ou seção");
      if (isNumberedSub(n) && text.length < 160) score("subcapitulo", .9, "numeração de subseção (1.1, VI.I…)");
      const citStrength = citationSignal(text, n, uppercaseRatio);
      if (uppercaseRatio > .6 && text.length < 160 && !PARTES.test(n) && !isCNJ && !isVocative && !isListItem && !/^[A-Z]\)/.test(text.trim()) && !citStrength) {
        score(isFirst ? "titulo" : "capitulo", isFirst ? .7 : .6, "hierarquia visual e caixa do título");
      }
      // Título da peça: só linhas CURTAS (o nome da peça é curto). Uma ementa longa
      // em caixa alta que começa com "AGRAVO DE INSTRUMENTO. AÇÃO DE…" é citação, não título.
      if (!isCNJ && !citStrength && text.length < 100 && /^(PETICAO|PETIÇÃO|CONTESTACAO|CONTESTAÇÃO|CONTRARRAZOES|CONTRARRAZÕES|CONTRAMINUTA|IMPUGNACAO|IMPUGNAÇÃO|RECURSO\s+DE|APELACAO|APELAÇÃO|AGRAVO\s+DE|EMBARGOS\s+DE|MANIFESTACAO|MANIFESTAÇÃO|RAZOES|RAZÕES|ALEGACOES\s+FINAIS|EXCECAO|EXCEÇÃO|RECLAMACAO|RECLAMAÇÃO)\b/.test(n)) score("titulo", .74, "nome da peça");
      if (isVocative) score("corpo", .5, "saudação/vocativo ao juízo");

      // Citação: por CONTEÚDO (forte) ou por recuo (moderado)
      if (citStrength) score("citacao", citStrength, "aspas ou marcador de citação (Súmula, STJ, REsp, transcrição, ementa)");
      else if (indented && !looksLikeSectionTitle(n) && !FECHO_RE.test(n) && !isVocative) score("citacao", .55, "bloco recuado compatível com citação");

      // Pedidos
      if (/^(?:DIANTE\s+DO\s+EXPOSTO|ANTE\s+O\s+EXPOSTO|POR\s+TODO\s+O\s+EXPOSTO|REQUER(?:EMOS|ENTE|IMENTOS)?|PEDE(?:-SE)?\b|PUGNA|REQUER-SE|DIGNEM-SE|ISTO\s+POSTO)/.test(n) || /(?:PEDIDOS|REQUERIMENTOS)\s*:?\s*$/.test(n)) score("pedidos", .8, "vocabulário de pedidos");

      // Fechamento (inclui NESTES/NESSES termos)
      if (FECHO_RE.test(n)) score("fechamento", .96, "fórmula de fechamento");
      if (/(?:^|\s)(?:SUBSCREVO|ATENCIOSAMENTE|RESPEITOSAMENTE|CORDIALMENTE)\b/.test(n) && text.length < 60) score("fechamento", .5, "fórmula final");

      // Data / local (guardando contra número CNJ)
      if (!isCNJ && (DATE_RE.test(n) || (DATE_NUM.test(n) && text.length < 80))) score("data", .9, "data localizada por padrão de calendário");

      // Assinatura: OAB, ou nome curto ao final.
      if (OAB_RE.test(n)) score("assinatura", .92, "registro OAB");
      if (/(?:ADVOGAD[OA]|PROCURADOR(?:A)?)\b/.test(n) && text.length < 70) score("assinatura", .6, "menção profissional em linha curta");
      if (isLast && looksLikeSignatureName(text)) score("assinatura", .6, "nome em posição final");

      if (index === 0 && !scores.enderecamento && !scores.titulo && !scores.identificacao) score("titulo", .36, "primeiro bloco da petição");

      score("corpo", .3, "bloco textual sem marcador dominante");

      const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
      const best = ranked[0] || ["corpo", .3];
      const second = ranked[1] ? ranked[1][1] : 0;
      item.kind = best[0];
      item.confidence = Math.min(.99, best[1]);
      item.reason = reasons[item.kind] || "classificação contextual";

      if (item.kind === "corpo") {
        const competitor = ranked.find(([k]) => k !== "corpo");
        const near = competitor && competitor[1] >= .5 && (competitor[1] - best[1]) > -.05;
        item.confidence = near ? .55 : .8;
        item.needsReview = !!near;
        item.reason = near ? `texto corrido (ou ${TYPE_LABELS[competitor[0]] || competitor[0]}?)` : "texto corrido";
      } else {
        item.needsReview = item.confidence < .6 || (second && best[1] - second < .1);
      }
    });

    // Figuras sem texto + legenda por contexto
    items.forEach((item, index) => {
      if (!item.text.trim() && item.hasImage) { item.kind = "figura"; item.confidence = .98; item.needsReview = false; item.reason = "imagem ou desenho sem texto encontrado no XML"; }
      const previous = items[index - 1];
      const captionByContext = previous && previous.kind === "figura" && (looksLikeCaption(item.text) || !previous.text.trim());
      if (captionByContext && item.kind !== "tabela") { item.kind = "legenda"; item.confidence = .86; item.needsReview = false; item.reason = looksLikeCaption(item.text) ? "marcador de legenda após figura" : "bloco imediatamente posterior à figura"; }
    });

    // Continuação de citação (mesmo estilo/recuo), sem invadir blocos estruturais nem o fecho
    items.forEach((item, index) => {
      const previous = items[index - 1];
      const sameStyle = previous && item.props.style && item.props.style === previous.props.style;
      if (previous && previous.kind === "citacao" && !STRUCTURAL_KINDS.has(item.kind) && item.kind !== "fechamento" && !FECHO_RE.test(norm(item.text)) && (item.props.left >= 1400 || sameStyle)) {
        item.kind = "citacao"; item.confidence = Math.max(item.confidence, .82); item.needsReview = false; item.reason = "parágrafo consecutivo com o mesmo contexto da citação";
      }
    });

    // ZONA DE ASSINATURA: depois de um fechamento, os blocos seguintes são
    // data/assinatura — nunca citação —, mesmo que estejam recuados a 6 cm.
    let inSignature = false;
    items.forEach((item) => {
      const n = norm(item.text);
      if (item.kind === "fechamento" || FECHO_RE.test(n)) { item.kind = "fechamento"; item.confidence = Math.max(item.confidence, .96); item.needsReview = false; item.reason = "fórmula de fechamento"; inSignature = true; return; }
      if (!inSignature) return;
      if (!item.text.trim()) { item.kind = "espaco"; return; }
      if (!CNJ.test(n) && (DATE_RE.test(n) || DATE_NUM.test(n)) && item.text.trim().length < 80) { item.kind = "data"; item.confidence = .95; item.needsReview = false; item.reason = "data do fecho da peça"; return; }
      if (OAB_RE.test(n) || looksLikeSignatureName(item.text)) { item.kind = "assinatura"; item.confidence = .92; item.needsReview = false; item.reason = "bloco de assinatura (após o fecho)"; return; }
      if (looksLikeSectionTitle(n) || VOCATIVE.test(n) || /^(AO|AOS|A|À|AS)\s+(JUIZO|JUÍZO|TRIBUNAL|VARA|EXCELENT)/.test(n) || /RAZOES|EXCELENTISSIMO|MANIFESTA/.test(n) || item.kind === "pedidos" || item.text.trim().length > 160) { inSignature = false; return; }
      item.kind = "assinatura"; item.confidence = .85; item.needsReview = false; item.reason = "bloco de assinatura (após o fecho)";
    });

    // Nome imediatamente antes de OAB/assinatura
    items.forEach((item, index) => {
      const next = items[index + 1];
      const afterDateOrClosing = items.slice(Math.max(0, index - 2), index).some((c) => ["data", "fechamento"].includes(c.kind));
      if ((next && next.kind === "assinatura" || afterDateOrClosing) && ["corpo", "outro"].includes(item.kind) && looksLikeSignatureName(item.text)) {
        item.kind = "assinatura"; item.confidence = .84; item.needsReview = false; item.reason = "nome contextualizado pelo bloco de assinatura";
      }
    });

    // Agrupa citações vizinhas para aplicar recuo e tipografia no bloco inteiro.
    let group = 0;
    items.forEach((item, index) => {
      if (item.kind === "citacao") { if (!items[index - 1] || items[index - 1].kind !== "citacao") group += 1; item.quoteGroup = group; }
    });
    return items;
  }


  function renderPreview() {
    const list = $("blocks-list");
    const reviewCount = state.items.filter((item) => item.needsReview).length;
    setText("metric-blocks", state.items.length);
    const matrixImages = state.matrixZip ? Object.keys(state.matrixZip.files).filter((name) => /^word\/media\//.test(name)).length : 0;
    setText("metric-images", matrixImages);
    $("review-warning").classList.toggle("is-hidden", reviewCount === 0);
    $("review-warning").innerHTML = reviewCount ? `Há <b>${reviewCount} bloco(s)</b> com confiança baixa ou sinais concorrentes. A saída só será liberada depois que você revisar a classificação e confirmar o conjunto.` : "";

    // Por padrão só mostra o que pede atenção (blocos estruturais/especiais + "conferir");
    // o corpo comum fica oculto até ligar a conferência minuciosa.
    const isVisible = (item) => state.detailedReview
      ? item.kind !== "espaco"
      : (item.needsReview || !["corpo", "espaco"].includes(item.kind));
    const shown = state.items.filter(isVisible);
    const hiddenBody = state.detailedReview ? 0 : state.items.filter((i) => i.kind === "corpo" && !i.needsReview).length;
    setText("review-count", `${shown.length} de ${state.items.length} blocos · ${reviewCount} conferir`);
    const note = $("review-hidden-note");
    if (note) {
      const show = !state.detailedReview && hiddenBody > 0;
      note.classList.toggle("is-hidden", !show);
      if (show) note.innerHTML = `<b>${hiddenBody}</b> parágrafo(s) de corpo ocultos. Ligue a <b>conferência minuciosa</b> acima para ver todos.`;
    }

    list.innerHTML = shown.map((item) => {
      const index = item.index;
      const options = TYPES.map(([value, label]) => `<option value="${value}" ${item.kind === value ? "selected" : ""}>${label}</option>`).join("");
      const confidence = item.needsReview ? "conferir" : `${Math.round(item.confidence * 100)}% confiança`;
      return `<article class="block-row ${item.needsReview ? "needs-review" : ""} ${previewClasses(item, index)}" data-index="${index}">
        <div class="block-number">${String(index + 1).padStart(2, "0")}</div>
        <div class="block-meta"><select class="block-select" aria-label="Tipo do bloco ${index + 1}">${options}</select><span class="confidence">${confidence}</span></div>
        <textarea class="block-editor" aria-label="Texto do bloco ${index + 1}">${esc(item.text)}</textarea>
        <div class="block-reason">${esc(item.reason)}${item.quoteGroup ? ` · citação ${item.quoteGroup}` : ""}</div>
      </article>`;
    }).join("");
    list.querySelectorAll(".block-select").forEach((select) => select.addEventListener("change", (event) => {
      const index = Number(event.target.closest(".block-row").dataset.index);
      state.items[index].kind = event.target.value;
      state.items[index].needsReview = event.target.value === "outro";
      state.items[index].confidence = state.items[index].needsReview ? .3 : 1;
      state.items[index].reason = "classificação confirmada pelo usuário";
      renderPreview();
      updateGenerateButton();
    }));
    list.querySelectorAll(".block-editor").forEach((editor) => editor.addEventListener("input", (event) => {
      const index = Number(event.target.closest(".block-row").dataset.index);
      state.items[index].text = event.target.value;
      updateGenerateButton();
    }));
  }

  function previewClasses(item, index) {
    const classes = [];
    if (item.kind === "citacao") classes.push("preview-quote");
    if (state.modelId === "bipartida") {
      if (item.kind === "enderecamento") classes.push("preview-address");
      if (item.kind === "identificacao") classes.push("preview-identification");
      if (item.kind === "fechamento") classes.push("preview-closing");
      if (item.kind === "data") classes.push("preview-date");
      if (item.kind === "assinatura") classes.push("preview-signature");
      if (item.kind === "corpo" && !state.items.slice(0, index).some((candidate) => candidate.kind === "corpo")) classes.push("preview-first-body");
    }
    return classes.join(" ");
  }

  function resetAnalysis() {
    state.analyzed = false; state.items = []; state.petitionXml = null;
    $("review-panel").classList.add("is-hidden"); $("generate-panel").classList.add("is-hidden");
    $("confirm-review").checked = false;
    $("file-observations").scrollIntoView({ behavior: "smooth", block: "center" });
    setActiveSteps(1);
    updateFlow(state.matrixFile && state.petitionFile ? "Arquivos prontos" : "Aguardando arquivos", "Você pode trocar um dos arquivos ou identificar novamente.", 13);
  }

  function updateGenerateButton() {
    const confirmed = $("confirm-review").checked;
    $("generate-btn").disabled = !state.analyzed || !confirmed || state.busy;
  }
  function setBusy(value) {
    state.busy = value;
    $("analyze-btn").disabled = value || !(state.matrixFile && state.petitionFile);
    updateGenerateButton();
    document.body.classList.toggle("is-busy", value);
  }
  function updateFlow(title, detail, progress) {
    setText("flow-status", title); setText("flow-detail", detail);
    if ($("progress-bar")) $("progress-bar").style.width = `${progress}%`;
  }
  function setActiveSteps(active) {
    document.querySelectorAll(".step").forEach((step) => {
      const number = Number(step.dataset.step);
      step.classList.toggle("is-current", number === active);
      step.classList.toggle("is-done", number < active);
    });
  }
  function showNotice(id, message, type) {
    const notice = $(id);
    notice.className = `notice ${type || ""}`;
    notice.textContent = message;
  }

  async function generate() {
    if (!state.analyzed || !$("confirm-review").checked || state.busy) return;
    const config = MODEL_CONFIGS[state.modelId];
    setBusy(true);
    showNotice("generation-result", "Montando o pacote DOCX a partir da matriz e validando o preview…", "");
    $("generation-result").classList.remove("is-hidden");
    try {
      if (config.id === "bipartida" && !state.items.some((item) => item.kind === "assinatura")) {
        throw new Error("A peça bipartida precisa de um bloco de assinatura. Classifique o nome/OAB final como Assinatura antes de gerar.");
      }
      updateFlow("Transformando OOXML", "Preservando relações, imagens, cabeçalho, rodapé e estilos da matriz…", 72);
      const outputZip = await transformDocx(config);
      const validation = await validateOutput(outputZip, config);
      if (validation.errors.length) throw new Error(validation.errors.join(" "));
      const blob = await outputZip.generateAsync({ type: "blob", mimeType: DOCX_MIME });
      const fileName = cleanFileName($("output-name").value);
      downloadBlob(blob, fileName);
      const notes = validation.notes.length ? ` ${validation.notes.join(" ")}` : "";
      showNotice("generation-result", `DOCX gerado e baixado como “${fileName}”.${notes}`, "success");
      updateFlow("Documento gerado", "A saída foi validada contra as regras essenciais do preview.", 100);
      setActiveSteps(4);
    } catch (error) {
      showNotice("generation-result", error.message || "Não foi possível gerar o DOCX. A conferência continua disponível.", "error");
      updateFlow("Geração interrompida", "Nenhum arquivo incorreto foi baixado. Ajuste a conferência e tente novamente.", 55);
    } finally {
      setBusy(false);
    }
  }

  async function transformDocx(config) {
    const output = await JSZip.loadAsync(await state.matrixFile.arrayBuffer());
    const source = parseXml(state.petitionXml);
    const sourceParts = await mergeSourceParts(state.petitionZip, output);
    const matrixXml = await output.file("word/document.xml").async("string");
    const matrix = parseXml(matrixXml);
    const sourceNodes = bodyChildren(source).filter((node) => ["p", "tbl", "sdt", "altChunk"].includes(node.localName));
    const matrixBody = Array.from(matrix.getElementsByTagNameNS(W_NS, "body"))[0];
    if (!matrixBody) throw new Error("A matriz não possui corpo word/document.xml utilizável.");
    const sectPr = Array.from(matrixBody.childNodes).find((node) => node.nodeType === 1 && node.localName === "sectPr");
    Array.from(matrixBody.childNodes).forEach((node) => { if (node !== sectPr) matrixBody.removeChild(node); });
    const lastSignatureIndex = state.items.reduce((last, item, index) => item.kind === "assinatura" ? index : last, -1);
    for (let index = 0; index < sourceNodes.length; index += 1) {
      const item = state.items[index];
      const clone = sourceNodes[index].cloneNode(true);
      // Parágrafos vazios do original são descartados: o espaçamento passa a ser
      // controlado pelas regras da matriz textual (evita linhas em branco soltas).
      // Exceção: se o parágrafo vazio carrega uma quebra de seção (sectPr), é mantido.
      if (item && item.kind === "espaco" && clone.localName === "p" && descendants(clone, "sectPr").length === 0) continue;
      remapSourceReferences(clone, sourceParts);
      if (item && item.text !== item.originalText) setElementText(clone, item.text);
      if (item && clone.localName === "p") applyParagraphRules(clone, item, config);
      await remapRelationships(clone, state.petitionZip, output);
      matrixBody.insertBefore(matrix.importNode(clone, true), sectPr || null);
      if (config.rules.pageBreakAfterSignature && index === lastSignatureIndex) {
        matrixBody.insertBefore(createPageBreakParagraph(matrix), sectPr || null);
      }
    }
    // O timbre Becker é uma imagem de página inteira atrás do texto, com a faixa
    // de endereço ocupando os ~3 cm inferiores. Garante margem inferior de 3,5 cm
    // (2000 twips) para o texto não invadir a faixa do rodapé.
    if (sectPr) {
      const pgMar = descendants(sectPr, "pgMar")[0];
      if (pgMar && Number(attr(pgMar, W_NS, "bottom") || 0) < 2000) setAttr(pgMar, W_NS, "bottom", 2000);
    }
    output.file("word/document.xml", new XMLSerializer().serializeToString(matrix));
    return output;
  }

  async function mergeSourceParts(sourceZip, outputZip) {
    const styles = await mergeSourceStyles(sourceZip, outputZip);
    const numbering = await mergeSourceNumbering(sourceZip, outputZip);
    return { styles, numbering };
  }

  async function mergeSourceStyles(sourceZip, outputZip) {
    const sourceFile = sourceZip.file("word/styles.xml");
    if (!sourceFile) return { ids: {}, defaultParagraphId: null };

    const sourceDoc = parseXml(await sourceFile.async("string"));
    const sourceStyles = Array.from(sourceDoc.getElementsByTagNameNS(W_NS, "style"));
    if (!sourceStyles.length) return { ids: {}, defaultParagraphId: null };

    const outputFile = outputZip.file("word/styles.xml");
    const outputDoc = outputFile
      ? parseXml(await outputFile.async("string"))
      : parseXml(`<w:styles xmlns:w="${W_NS}"></w:styles>`);
    const usedIds = new Set(
      Array.from(outputDoc.getElementsByTagNameNS(W_NS, "style"))
        .map((style) => attr(style, W_NS, "styleId"))
        .filter(Boolean)
    );
    const ids = {};
    sourceStyles.forEach((style) => {
      const originalId = attr(style, W_NS, "styleId");
      if (originalId) ids[originalId] = uniqueStyleId(`Peticao_${originalId}`, usedIds);
    });

    sourceStyles.forEach((style) => {
      const originalId = attr(style, W_NS, "styleId");
      if (!originalId || !ids[originalId]) return;
      const copy = outputDoc.importNode(style, true);
      setAttr(copy, W_NS, "styleId", ids[originalId]);
      remapStyleReferences(copy, ids);
      outputDoc.documentElement.appendChild(copy);
    });
    outputZip.file("word/styles.xml", new XMLSerializer().serializeToString(outputDoc));

    const defaultParagraph = sourceStyles.find((style) =>
      attr(style, W_NS, "type") === "paragraph" && attr(style, W_NS, "default") === "1"
    );
    return {
      ids,
      defaultParagraphId: defaultParagraph ? ids[attr(defaultParagraph, W_NS, "styleId")] || null : null
    };
  }

  async function mergeSourceNumbering(sourceZip, outputZip) {
    const sourceFile = sourceZip.file("word/numbering.xml");
    if (!sourceFile) return { abstractIds: {}, numIds: {} };

    const sourceDoc = parseXml(await sourceFile.async("string"));
    const sourceAbstracts = Array.from(sourceDoc.getElementsByTagNameNS(W_NS, "abstractNum"));
    const sourceNums = Array.from(sourceDoc.getElementsByTagNameNS(W_NS, "num"));
    if (!sourceAbstracts.length && !sourceNums.length) return { abstractIds: {}, numIds: {} };

    const outputFile = outputZip.file("word/numbering.xml");
    const outputDoc = outputFile
      ? parseXml(await outputFile.async("string"))
      : parseXml(`<w:numbering xmlns:w="${W_NS}"></w:numbering>`);
    const usedAbstractIds = new Set(
      Array.from(outputDoc.getElementsByTagNameNS(W_NS, "abstractNum"))
        .map((node) => Number(attr(node, W_NS, "abstractNumId")))
        .filter(Number.isFinite)
    );
    const usedNumIds = new Set(
      Array.from(outputDoc.getElementsByTagNameNS(W_NS, "num"))
        .map((node) => Number(attr(node, W_NS, "numId")))
        .filter(Number.isFinite)
    );
    const abstractIds = {};
    const numIds = {};
    let nextAbstractId = nextNumericId(usedAbstractIds);
    let nextNumId = nextNumericId(usedNumIds);
    sourceAbstracts.forEach((node) => {
      const originalId = attr(node, W_NS, "abstractNumId");
      if (originalId != null) abstractIds[originalId] = String(nextAbstractId++);
    });
    sourceNums.forEach((node) => {
      const originalId = attr(node, W_NS, "numId");
      if (originalId != null) numIds[originalId] = String(nextNumId++);
    });

    sourceAbstracts.forEach((node) => {
      const copy = outputDoc.importNode(node, true);
      const originalId = attr(node, W_NS, "abstractNumId");
      if (abstractIds[originalId]) setAttr(copy, W_NS, "abstractNumId", abstractIds[originalId]);
      remapNumberingReferences(copy, abstractIds, numIds);
      outputDoc.documentElement.appendChild(copy);
    });
    sourceNums.forEach((node) => {
      const copy = outputDoc.importNode(node, true);
      const originalId = attr(node, W_NS, "numId");
      if (numIds[originalId]) setAttr(copy, W_NS, "numId", numIds[originalId]);
      remapNumberingReferences(copy, abstractIds, numIds);
      outputDoc.documentElement.appendChild(copy);
    });
    outputZip.file("word/numbering.xml", new XMLSerializer().serializeToString(outputDoc));
    return { abstractIds, numIds };
  }

  function remapSourceReferences(root, parts) {
    const elements = [root, ...Array.from(root.getElementsByTagName("*"))];
    elements.forEach((node) => {
      if (node.localName === "p" && parts.styles.defaultParagraphId) {
        const pPr = Array.from(node.childNodes).find((child) => child.nodeType === 1 && child.localName === "pPr");
        const styleNode = pPr && Array.from(pPr.childNodes).find((child) => child.nodeType === 1 && child.localName === "pStyle");
        if (!styleNode) {
          const paragraphProperties = pPr || node.ownerDocument.createElementNS(W_NS, "w:pPr");
          if (!pPr) node.insertBefore(paragraphProperties, node.firstChild);
          const defaultStyle = node.ownerDocument.createElementNS(W_NS, "w:pStyle");
          setAttr(defaultStyle, W_NS, "val", parts.styles.defaultParagraphId);
          paragraphProperties.insertBefore(defaultStyle, paragraphProperties.firstChild);
        }
      }
      remapStyleReferences(node, parts.styles.ids);
      remapNumberingReferences(node, parts.numbering.abstractIds, parts.numbering.numIds);
    });
  }

  function remapStyleReferences(root, ids) {
    if (!root || !root.localName) return;
    if (["pStyle", "rStyle", "tblStyle", "basedOn", "next", "link", "styleLink"].includes(root.localName)) {
      const originalId = attr(root, W_NS, "val");
      if (ids[originalId]) setAttr(root, W_NS, "val", ids[originalId]);
    }
  }

  function remapNumberingReferences(root, abstractIds, numIds) {
    if (!root || !root.localName) return;
    if (root.localName === "abstractNumId") {
      const originalId = attr(root, W_NS, "val");
      if (abstractIds[originalId]) setAttr(root, W_NS, "val", abstractIds[originalId]);
    }
    if (root.localName === "numId") {
      const originalId = attr(root, W_NS, "val");
      if (numIds[originalId]) setAttr(root, W_NS, "val", numIds[originalId]);
    }
  }

  function uniqueStyleId(base, usedIds) {
    const normalized = String(base).replace(/[^\w.-]/g, "_");
    let candidate = normalized;
    let index = 2;
    while (usedIds.has(candidate)) candidate = `${normalized}_${index++}`;
    usedIds.add(candidate);
    return candidate;
  }

  function nextNumericId(values) {
    return values.size ? Math.max(...values) + 1 : 1;
  }

  function ensureChild(parent, name) {
    let child = Array.from(parent.childNodes).find((node) => node.nodeType === 1 && node.localName === name);
    if (!child) {
      child = parent.ownerDocument.createElementNS(W_NS, `w:${name}`);
      parent.appendChild(child);
    }
    return child;
  }
  // ================= MATRIZ TEXTUAL BECKER =================
  // Medidas: 1 cm ≈ 567 twips; tamanhos em meio-ponto (12pt=24, 10pt=20);
  // espaçamento em twips (12pt=240). Cores hex sem "#".
  const CM6 = 3402;                 // 6 cm
  const AZUL = "002060";            // azul-escuro da faixa
  const BRANCO = "FFFFFF";
  const STYLE_RULES = {
    enderecamento: { font: "Calibri", size: 24, bold: true,  caps: true,  jc: "both",   left: 0,   firstLine: 0,   before: 0,   after: 480 },
    identificacao: { font: "Calibri", size: 24, bold: false, jc: "both",   left: 0,   firstLine: 0,   before: 0,   after: 0   },
    titulo:        { font: "Calibri", size: 24, bold: true,  caps: true,  color: BRANCO, fill: AZUL, jc: "center", left: 0,   firstLine: 0, before: 240, after: 240 },
    capitulo:      { font: "Calibri", size: 24, bold: true,  caps: true,  color: BRANCO, fill: AZUL, jc: "both",   left: CM6, firstLine: 0, before: 240, after: 240 },
    subcapitulo:   { font: "Calibri", size: 24, bold: true,  caps: true,  color: "auto", jc: "both",  left: CM6, firstLine: 0, before: 240, after: 240 },
    corpo:         { font: "Calibri", size: 24, bold: false, jc: "both",   left: 0,   firstLine: CM6, before: 240, after: 240 },
    citacao:       { font: "Calibri", size: 20, bold: false, jc: "both",   left: CM6, firstLine: 0,   before: 240, after: 240 },
    legenda:       { font: "Calibri", size: 20, bold: false, jc: "center", left: 0,   firstLine: 0,   before: 120, after: 240 },
    pedidos:       { font: "Calibri", size: 24, bold: false, jc: "both",   left: 0,   firstLine: CM6, before: 0,   after: 120 },
    fechamento:    { font: "Calibri", size: 24, bold: false, jc: "both",   left: CM6, firstLine: 0,   before: 240, after: 0   },
    data:          { font: "Calibri", size: 24, bold: false, jc: "both",   left: CM6, firstLine: 0,   before: 240, after: 240 },
    assinatura:    { font: "Calibri", size: 24, bold: true,  jc: "both",   left: CM6, firstLine: 0,   before: 0,   after: 0   }
  };

  function ensureChildFirst(parent, name) {
    let child = Array.from(parent.childNodes).find((node) => node.nodeType === 1 && node.localName === name);
    if (!child) {
      child = parent.ownerDocument.createElementNS(W_NS, `w:${name}`);
      // insere logo após pStyle (se houver), respeitando a ordem do schema
      const pStyle = Array.from(parent.childNodes).find((n) => n.nodeType === 1 && n.localName === "pStyle");
      parent.insertBefore(child, pStyle ? pStyle.nextSibling : parent.firstChild);
    }
    return child;
  }

  function applyParagraphRules(p, item, config) {
    const rule = STYLE_RULES[item.kind];
    if (!rule) return;
    const doc = p.ownerDocument;
    const pPr = (() => {
      let current = Array.from(p.childNodes).find((node) => node.nodeType === 1 && node.localName === "pPr");
      if (!current) { current = doc.createElementNS(W_NS, "w:pPr"); p.insertBefore(current, p.firstChild); }
      return current;
    })();

    // Alinhamento
    if (rule.jc) setAttr(ensureChild(pPr, "jc"), W_NS, "val", rule.jc);

    // Recuo (esquerdo + primeira linha)
    const ind = ensureChild(pPr, "ind");
    setAttr(ind, W_NS, "left", rule.left || 0);
    setAttr(ind, W_NS, "firstLine", rule.firstLine || 0);
    ["hanging", "right"].forEach((name) => ind.removeAttributeNS(W_NS, name));

    // Espaçamento (com regra especial do fecho: 12pt antes só na 1ª linha, 0 entre elas)
    const spacing = ensureChild(pPr, "spacing");
    let before = rule.before || 0;
    let after = rule.after || 0;
    if (item.kind === "fechamento") {
      const prev = state.items[item.index - 1];
      before = prev && prev.kind === "fechamento" ? 0 : 240;
      after = 0;
    }
    setAttr(spacing, W_NS, "before", before);
    setAttr(spacing, W_NS, "after", after);
    setAttr(spacing, W_NS, "line", 240);
    setAttr(spacing, W_NS, "lineRule", "auto");

    // Faixa azul (sombreamento) — presente só em capítulo/título; removida nos demais
    const existingShd = Array.from(pPr.childNodes).find((n) => n.nodeType === 1 && n.localName === "shd");
    if (rule.fill) {
      const shd = existingShd || ensureChildFirst(pPr, "shd");
      setAttr(shd, W_NS, "val", "clear");
      setAttr(shd, W_NS, "color", "auto");
      setAttr(shd, W_NS, "fill", rule.fill);
    } else if (existingShd) {
      pPr.removeChild(existingShd);
    }

    // Runs: fonte, tamanho, negrito, cor
    descendants(p, "r").forEach((run) => {
      const rPr = (() => {
        let r = Array.from(run.childNodes).find((node) => node.nodeType === 1 && node.localName === "rPr");
        if (!r) { r = doc.createElementNS(W_NS, "w:rPr"); run.insertBefore(r, run.firstChild); }
        return r;
      })();
      const fonts = ensureChild(rPr, "rFonts");
      ["ascii", "hAnsi", "eastAsia", "cs"].forEach((name) => setAttr(fonts, W_NS, name, rule.font));
      setAttr(ensureChild(rPr, "sz"), W_NS, "val", rule.size);
      setAttr(ensureChild(rPr, "szCs"), W_NS, "val", rule.size);
      if (rule.bold) { ensureChild(rPr, "b"); ensureChild(rPr, "bCs"); }
      if (rule.color) setAttr(ensureChild(rPr, "color"), W_NS, "val", rule.color);
    });

    // Caixa alta para títulos/endereçamento/capítulos (o conteúdo textual já costuma vir em maiúsculas)
    if (rule.caps) {
      descendants(p, "t").forEach((t) => { if (t.textContent) t.textContent = t.textContent.toLocaleUpperCase("pt-BR"); });
    }
  }
  function setElementText(element, value) {
    const textNodes = descendants(element, "t");
    if (textNodes.length) {
      textNodes[0].textContent = value;
      textNodes.slice(1).forEach((node) => { node.textContent = ""; });
    } else if (element.localName === "p" && value) {
      const run = element.ownerDocument.createElementNS(W_NS, "w:r");
      const text = element.ownerDocument.createElementNS(W_NS, "w:t");
      text.textContent = value; run.appendChild(text); element.appendChild(run);
    }
  }
  function createPageBreakParagraph(doc) {
    const p = doc.createElementNS(W_NS, "w:p");
    const r = doc.createElementNS(W_NS, "w:r");
    const br = doc.createElementNS(W_NS, "w:br");
    setAttr(br, W_NS, "type", "page");
    r.appendChild(br); p.appendChild(r); return p;
  }

  async function remapRelationships(element, sourceZip, outputZip) {
    const relFile = sourceZip.file("word/_rels/document.xml.rels");
    if (!relFile) return;
    const sourceRels = parseXml(await relFile.async("string"));
    const relationNodes = Array.from(sourceRels.getElementsByTagNameNS(REL_NS, "Relationship"));
    const relationMap = Object.fromEntries(relationNodes.map((rel) => [rel.getAttribute("Id"), rel]));
    const ids = new Set();
    Array.from(element.getElementsByTagName("*")).forEach((node) => {
      [node.getAttributeNS(R_NS, "embed"), node.getAttributeNS(R_NS, "id"), node.getAttributeNS(R_NS, "link")].filter(Boolean).forEach((id) => ids.add(id));
    });
    const outputRelsPath = "word/_rels/document.xml.rels";
    const outputRelsFile = outputZip.file(outputRelsPath);
    const outputRels = outputRelsFile ? parseXml(await outputRelsFile.async("string")) : parseXml(`<Relationships xmlns="${REL_NS}"></Relationships>`);
    let serial = 1;
    const existing = () => new Set(Array.from(outputRels.getElementsByTagNameNS(REL_NS, "Relationship")).map((rel) => rel.getAttribute("Id")));
    for (const oldId of ids) {
      const rel = relationMap[oldId];
      if (!rel) continue;
      const currentIds = existing();
      let newId = oldId;
      while (currentIds.has(newId)) newId = `rIdImported${serial++}`;
      if (newId !== oldId) {
        Array.from(element.getElementsByTagName("*")).forEach((node) => {
          ["embed", "id", "link"].forEach((name) => { if (node.getAttributeNS(R_NS, name) === oldId) node.setAttributeNS(R_NS, `r:${name}`, newId); });
        });
      }
      const copied = outputRels.createElementNS(REL_NS, "Relationship");
      Array.from(rel.attributes).forEach((attribute) => copied.setAttribute(attribute.name, attribute.value));
      copied.setAttribute("Id", newId);
      outputRels.documentElement.appendChild(copied);
      const targetMode = rel.getAttribute("TargetMode");
      const target = rel.getAttribute("Target") || "";
      if (!targetMode && rel.getAttribute("Type") && /\/image$/.test(rel.getAttribute("Type"))) {
        const sourcePath = resolvePart("word/document.xml", target);
        const sourcePart = sourceZip.file(sourcePath);
        if (sourcePart) {
          const ext = (sourcePath.match(/\.([a-z0-9]+)$/i) || ["", "bin"])[1];
          const destination = uniqueZipPath(outputZip, `word/media/imported-${serial}.${ext}`);
          outputZip.file(destination, await sourcePart.async("uint8array"));
          await ensureContentType(outputZip, destination, sourceZip);
          copied.setAttribute("Target", destination.replace(/^word\//, ""));
        }
      }
    }
    outputZip.file(outputRelsPath, new XMLSerializer().serializeToString(outputRels));
  }
  function resolvePart(base, target) {
    if (target.startsWith("/")) return target.slice(1);
    const parts = base.split("/");
    parts.pop();
    target.split("/").forEach((part) => { if (!part || part === ".") return; if (part === "..") parts.pop(); else parts.push(part); });
    return parts.join("/");
  }
  function uniqueZipPath(zip, path) {
    if (!zip.file(path)) return path;
    const match = path.match(/^(.*?)(\.[^.]*)?$/);
    let i = 2;
    while (zip.file(`${match[1]}-${i}${match[2] || ""}`)) i += 1;
    return `${match[1]}-${i}${match[2] || ""}`;
  }
  async function ensureContentType(zip, path, sourceZip) {
    const contentFile = zip.file("[Content_Types].xml");
    if (!contentFile) return;
    const doc = parseXml(await contentFile.async("string"));
    const ext = (path.match(/\.([^.]+)$/) || ["", ""])[1].toLowerCase();
    const hasDefault = Array.from(doc.getElementsByTagNameNS(CT_NS, "Default")).some((node) => node.getAttribute("Extension").toLowerCase() === ext);
    if (hasDefault) return;
    const sourceContent = sourceZip.file("[Content_Types].xml");
    const sourceDoc = sourceContent ? parseXml(await sourceContent.async("string")) : null;
    const sourceDefault = sourceDoc && Array.from(sourceDoc.getElementsByTagNameNS(CT_NS, "Default")).find((node) => node.getAttribute("Extension").toLowerCase() === ext);
    const defaultNode = doc.createElementNS(CT_NS, "Default");
    defaultNode.setAttribute("Extension", ext);
    defaultNode.setAttribute("ContentType", sourceDefault ? sourceDefault.getAttribute("ContentType") : guessMime(ext));
    doc.documentElement.appendChild(defaultNode);
    zip.file("[Content_Types].xml", new XMLSerializer().serializeToString(doc));
  }
  function guessMime(ext) {
    return ({ png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", svg: "image/svg+xml", emf: "image/x-emf", wmf: "image/x-wmf" })[ext] || "application/octet-stream";
  }

  async function validateOutput(zip, config) {
    const errors = []; const notes = [];
    const xml = await zip.file("word/document.xml").async("string");
    const doc = parseXml(xml);
    const outputBodyNodes = bodyChildren(doc).filter((node) => ["p", "tbl", "sdt", "altChunk"].includes(node.localName));

    // Estrutura da matriz preservada — estes SÃO erros reais (risco de corromper o DOCX).
    const outputImages = Object.keys(zip.files).filter((name) => /^word\/media\//.test(name)).length;
    const matrixImages = Object.keys(state.matrixZip.files).filter((name) => /^word\/media\//.test(name)).length;
    if (outputImages < matrixImages) errors.push("A saída perdeu imagens presentes na matriz.");
    const matrixParts = Object.keys(state.matrixZip.files).filter((name) => !state.matrixZip.files[name].dir);
    const missingMatrixParts = matrixParts.filter((name) => !zip.file(name));
    if (missingMatrixParts.length) errors.push(`A saída perdeu ${missingMatrixParts.length} parte(s) da matriz Becker.`);
    const countParts = (source, expression) => Object.keys(source.files).filter((name) => expression.test(name)).length;
    const matrixHeaders = countParts(state.matrixZip, /^word\/header\d+\.xml$/);
    const matrixFooters = countParts(state.matrixZip, /^word\/footer\d+\.xml$/);
    const outputHeaders = countParts(zip, /^word\/header\d+\.xml$/);
    const outputFooters = countParts(zip, /^word\/footer\d+\.xml$/);
    if (outputHeaders !== matrixHeaders || outputFooters !== matrixFooters) {
      errors.push("A saída não preservou a quantidade de cabeçalhos e rodapés da matriz.");
    }

    // Mapeia item -> parágrafo de saída (na ordem), pulando a quebra de página inserida.
    const lastSignatureIndex = state.items.reduce((last, item, index) => item.kind === "assinatura" ? index : last, -1);
    const runsCalibri = (p, halfPt) => {
      const runs = Array.from(p.getElementsByTagNameNS(W_NS, "r"));
      if (!runs.length) return true;
      return runs.every((run) => {
        const rPr = descendants(run, "rPr")[0];
        const rFonts = descendants(rPr, "rFonts")[0];
        const size = Number(attr(descendants(rPr, "sz")[0], W_NS, "val") || 0);
        return rFonts && attr(rFonts, W_NS, "ascii") === "Calibri" && size === halfPt;
      });
    };
    // Validação sem depender de alinhamento posicional (parágrafos vazios são
    // descartados na geração, então o índice item↔parágrafo não é 1:1).
    const quotesTotal = state.items.filter((it) => it.kind === "citacao").length;
    const quotesOK = outputBodyNodes.filter((n) => n.localName === "p" && runsCalibri(n, 20) && Number(attr(descendants(descendants(n, "pPr")[0], "ind")[0], W_NS, "left") || 0) === CM6).length;
    const pageBreakOK = outputBodyNodes.some((n) => n.localName === "p" && Array.from(n.getElementsByTagNameNS(W_NS, "br")).some((b) => attr(b, W_NS, "type") === "page"));
    if (config.rules.pageBreakAfterSignature && lastSignatureIndex >= 0 && !pageBreakOK) {
      errors.push("A quebra de página não foi encontrada imediatamente após a assinatura.");
    }

    // Formatação = NOTAS informativas (nunca bloqueia o download).
    if (quotesTotal) notes.push(`${quotesOK}/${quotesTotal} citação(ões) formatada(s) com Calibri 10 e recuo de 6 cm.`);
    if (config.rules.pageBreakAfterSignature && pageBreakOK) notes.push("Quebra de página após a assinatura aplicada.");
    notes.push(`${outputImages} imagem(ns), ${outputHeaders} cabeçalho(s) e ${outputFooters} rodapé(s) no pacote final.`);
    return { errors, notes };
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url; link.download = filename; document.body.appendChild(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }





  function looksLikeCaption(text) {
    return /^(?:FIGURA|FIG\.|IMAGEM|ILUSTRACAO|ILUSTRAÇÃO|FOTO|QUADRO|FONTE)\b/.test(norm(text));
  }

  window.addEventListener("DOMContentLoaded", init);
})();
