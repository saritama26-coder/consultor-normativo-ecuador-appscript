/**
 * CONSULTOR NORMATIVO ECUADOR
 * Backend: Google Apps Script — versión corregida (2026-10-13)
 *
 * Cambios respecto a las versiones anteriores:
 * 1. Recorre SUBCARPETAS (la carpeta "Leyes Vigentes" solo contiene subcarpetas).
 * 2. Indexación INCREMENTAL: guarda cada documento apenas se procesa y continúa
 *    automáticamente con un activador si se acerca al límite de 6 minutos.
 * 3. Corrige la búsqueda exacta de artículos con formato ecuatoriano "Art. 26.-".
 * 4. Corta fragmentos en el inicio de un artículo para no partirlos.
 * 5. Compatible con Drive API v3 (Files.create) y v2 (Files.insert).
 *
 * Cambios 2026-10-15:
 * 6. Modos de búsqueda: todas las palabras (por defecto), frase exacta y
 *    cualquier palabra; comparación por palabra completa (admite plural) y
 *    frases entre comillas.
 * 7. Relevancia: cobertura, frase completa, cercanía entre términos, frecuencia
 *    y coincidencia en etiqueta/nombre; se devuelve relevancia relativa (%).
 * 8. Paginación (offset/limite), agrupación de coincidencias por documento y
 *    lista de documentos excluidos por falta de texto.
 * 9. Búsqueda directa de artículo con norma: "art. 365 RGLOSNCP".
 * 10. Página de la coincidencia y rango de páginas del extracto; limpieza de
 *     encabezados/pies editoriales solo para mostrar.
 * 11. Columna H "Verificación" en Documentos (valor "Verificado ..."), fecha
 *     del archivo y "Última modificación" declarada en el texto.
 * 12. OCR con reintento por tramos más pequeños y diagnóstico de documentos
 *     sin texto: diagnosticarDocumentosSinTexto(), luego reintentarErrores().
 *
 * No incluye interpretación automática ni referencias APA.
 */

const CONFIG = {
  SPREADSHEET_ID: '1d1ng1tSoSPBcvX6frybVbNZcQbuT-wsYrgrjA6Jp6Mc',
  FOLDER_IDS: [
    '1tChmi3ToWPgpr4uf0nxCMmSYxeqr5EKR', // Leyes Vigentes (contiene subcarpetas)
    '1lkSHboTzZGTtlKiy6NQMoUH7uQrLwVjr'  // NORMAS TECNICAS NEC
  ],
  INCLUIR_SUBCARPETAS: true,
  SHEET_ARTICLES: 'Articulos',
  SHEET_DOCUMENTS: 'Documentos',
  MAX_RESULTS: 30,
  CHUNK_CHARS: 8500,
  OCR_LANGUAGE: 'es',
  OCR_MAX_PAGINAS: 80, // límite de páginas del OCR de Drive por conversión
  OCR_MIN_PAGINAS: 10, // tamaño mínimo de tramo al reintentar un OCR fallido
  PDF_LIB_URL: 'https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/dist/pdf-lib.min.js',
  MAX_EJECUCION_MS: 4.5 * 60 * 1000, // margen frente al límite de 6 min
  FUNCION_CONTINUAR: 'continuarIndexacion'
};

const HEADERS_ARTICLES = [
  'ID fuente', 'Documento', 'Tipo', 'Artículo detectado',
  'Texto', 'URL fuente', 'Fecha indexación', 'Estado revisión'
];
const HEADERS_DOCUMENTS = [
  'ID Drive', 'Nombre del documento', 'MIME type', 'URL',
  'Carpeta', 'Fecha indexación', 'Estado', 'Verificación'
];

const CATEGORIAS = [
  { id: 'CONSTITUCION', nombre: 'Constitución y normativa constitucional' },
  { id: 'CODIGOS', nombre: 'Códigos y legislación general' },
  { id: 'LEYES', nombre: 'Leyes orgánicas y ordinarias' },
  { id: 'REGLAMENTOS', nombre: 'Reglamentos, decretos y acuerdos' },
  { id: 'CONTRATACION', nombre: 'Contratación pública — SERCOP' },
  { id: 'CONTROL', nombre: 'Control público — Contraloría' },
  { id: 'SERVICIO_PUBLICO', nombre: 'Administración pública y servicio público' },
  { id: 'NEC', nombre: 'Construcción — NEC' },
  { id: 'URBANISMO', nombre: 'Urbanismo y ordenamiento territorial' },
  { id: 'DISCAPACIDAD', nombre: 'Accesibilidad y discapacidad' },
  { id: 'AMBIENTE_SEGURIDAD', nombre: 'Ambiente y seguridad ocupacional' },
  { id: 'INEN', nombre: 'Normas técnicas INEN' },
  { id: 'MANUALES', nombre: 'Manuales y especificaciones técnicas' },
  { id: 'RESOLUCIONES', nombre: 'Resoluciones y normativa institucional' },
  { id: 'OTROS', nombre: 'Otros documentos indexados' }
];

function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('Consultor Normativo Ecuador')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/* =========================================================================
 * ADMINISTRACIÓN DEL ÍNDICE (ejecutar desde el editor de Apps Script)
 * ========================================================================= */

/**
 * Inicializa encabezados. ADVERTENCIA: limpia las hojas y detiene activadores.
 */
function configurarSistema() {
  eliminarActivadores_();
  const ss = getSpreadsheet_();
  reiniciarHoja_(getOrCreateSheet_(ss, CONFIG.SHEET_ARTICLES, HEADERS_ARTICLES), HEADERS_ARTICLES);
  reiniciarHoja_(getOrCreateSheet_(ss, CONFIG.SHEET_DOCUMENTS, HEADERS_DOCUMENTS), HEADERS_DOCUMENTS);
  return { ok: true, message: 'Hojas inicializadas. El índice anterior fue limpiado.', spreadsheetUrl: ss.getUrl() };
}

/**
 * Indexación INCREMENTAL. Procesa solo los archivos que aún no están en la
 * hoja Documentos. Si se acerca al límite de tiempo, programa un activador
 * que continúa automáticamente hasta terminar. Puede ejecutarse varias veces.
 */
async function indexarDocumentosDrive() {
  return await procesarIndexacion_();
}

/** Destino del activador automático. No ejecutar manualmente (aunque es seguro). */
async function continuarIndexacion() {
  return await procesarIndexacion_();
}

/** Borra todo el índice y vuelve a indexar desde cero. */
async function reindexarTodo() {
  configurarSistema();
  return await procesarIndexacion_();
}

/**
 * Elimina del índice los documentos con estado de error o sin texto
 * (y sus fragmentos) y los vuelve a procesar.
 */
async function reintentarErrores() {
  const ss = getSpreadsheet_();
  const docSheet = getOrCreateSheet_(ss, CONFIG.SHEET_DOCUMENTS, HEADERS_DOCUMENTS);
  const artSheet = getOrCreateSheet_(ss, CONFIG.SHEET_ARTICLES, HEADERS_ARTICLES);
  if (docSheet.getLastRow() < 2) return await procesarIndexacion_();

  const docs = docSheet.getRange(2, 1, docSheet.getLastRow() - 1, 8).getValues();
  const reintentar = new Set();
  const conservar = docs.filter(function(r) {
    const estado = String(r[6] || '').trim();
    // Incluye errores de conversión/OCR, documentos sin texto y archivos
    // que solo devolvieron el índice o tabla de contenido.
    const fallido = /^(?:Error\b|Sin texto\b|Texto extraído, pero se detectó principalmente índice\b|Omitido:)/i.test(estado)
      || /principalmente índice/i.test(estado)
      || /sin dividir;.*texto.*incompleto/i.test(estado)
      || /OCR incompleto en págs\./.test(estado);
    if (fallido) reintentar.add(String(r[0]));
    return !fallido;
  });
  if (!reintentar.size) return { ok: true, message: 'No hay documentos con error para reintentar.' };

  replaceSheetBody_(docSheet, conservar, 8);
  if (artSheet.getLastRow() >= 2) {
    const arts = artSheet.getRange(2, 1, artSheet.getLastRow() - 1, 8).getValues()
      .filter(function(r) { return !reintentar.has(String(r[0])); });
    replaceSheetBody_(artSheet, arts, 8);
  }
  return await procesarIndexacion_();
}

/** Resumen del avance: total de archivos en Drive vs. indexados. */
function estadoIndexacion() {
  const archivos = listarArchivosConfigurados_();
  const ss = getSpreadsheet_();
  const docSheet = ss.getSheetByName(CONFIG.SHEET_DOCUMENTS);
  const artSheet = ss.getSheetByName(CONFIG.SHEET_ARTICLES);
  const estados = {};
  let procesados = 0;
  if (docSheet && docSheet.getLastRow() >= 2) {
    docSheet.getRange(2, 7, docSheet.getLastRow() - 1, 1).getValues().forEach(function(r) {
      const clave = String(r[0] || '').split(';')[0].split(':')[0];
      estados[clave] = (estados[clave] || 0) + 1;
      procesados++;
    });
  }
  const resultado = {
    archivosEnDrive: archivos.length,
    documentosProcesados: procesados,
    pendientes: Math.max(archivos.length - procesados, 0),
    fragmentos: artSheet ? Math.max(artSheet.getLastRow() - 1, 0) : 0,
    estados: estados,
    activadorPendiente: ScriptApp.getProjectTriggers().some(function(t) {
      return t.getHandlerFunction() === CONFIG.FUNCION_CONTINUAR;
    })
  };
  console.log(JSON.stringify(resultado, null, 2));
  return resultado;
}

/* =========================================================================
 * INDEXACIÓN
 * ========================================================================= */

async function procesarIndexacion_() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) {
    return { ok: false, message: 'Ya hay una indexación en curso. Espera a que termine.' };
  }
  const inicio = Date.now();
  try {
    eliminarActivadores_();
    validarConfiguracion_();
    const ss = getSpreadsheet_();
    const articleSheet = getOrCreateSheet_(ss, CONFIG.SHEET_ARTICLES, HEADERS_ARTICLES);
    const docSheet = getOrCreateSheet_(ss, CONFIG.SHEET_DOCUMENTS, HEADERS_DOCUMENTS);

    const yaIndexados = new Set();
    if (docSheet.getLastRow() >= 2) {
      docSheet.getRange(2, 1, docSheet.getLastRow() - 1, 1).getValues().forEach(function(r) {
        if (r[0]) yaIndexados.add(String(r[0]));
      });
    }

    const pendientes = listarArchivosConfigurados_().filter(function(f) {
      return !yaIndexados.has(f.id);
    });

    let procesadosAhora = 0;
    let fragmentosAhora = 0;

    for (let i = 0; i < pendientes.length; i++) {
      if (Date.now() - inicio > CONFIG.MAX_EJECUCION_MS) {
        programarContinuacion_();
        return {
          ok: true,
          completo: false,
          procesadosEnEstaEjecucion: procesadosAhora,
          pendientes: pendientes.length - i,
          message: 'Límite de tiempo cercano. La indexación continuará automáticamente en 1 minuto.'
        };
      }
      const r = await indexarArchivo_(pendientes[i]);
      if (r.filas.length) {
        articleSheet.getRange(articleSheet.getLastRow() + 1, 1, r.filas.length, 8).setValues(r.filas);
      }
      docSheet.appendRow(r.documento);
      SpreadsheetApp.flush();
      procesadosAhora++;
      fragmentosAhora += r.filas.length;
    }

    return {
      ok: true,
      completo: true,
      procesadosEnEstaEjecucion: procesadosAhora,
      fragmentosEnEstaEjecucion: fragmentosAhora,
      spreadsheetUrl: ss.getUrl(),
      message: 'Indexación finalizada. Revisa los estados y verifica la vigencia de las fuentes.'
    };
  } finally {
    lock.releaseLock();
  }
}

/** Lista PDF y Google Docs de las carpetas configuradas (y subcarpetas). */
function listarArchivosConfigurados_() {
  const salida = [];
  const vistos = new Set();
  const carpetasVistas = new Set();
  CONFIG.FOLDER_IDS.forEach(function(folderId) {
    const folder = DriveApp.getFolderById(folderId);
    recorrerCarpeta_(folder, folder.getName(), salida, vistos, carpetasVistas);
  });
  return salida;
}

function recorrerCarpeta_(folder, ruta, salida, vistos, carpetasVistas) {
  const fid = folder.getId();
  if (carpetasVistas.has(fid)) return;
  carpetasVistas.add(fid);

  const files = folder.getFiles();
  while (files.hasNext()) {
    const file = files.next();
    const id = file.getId();
    if (vistos.has(id)) continue;
    vistos.add(id);
    salida.push({
      id: id,
      nombre: file.getName(),
      mime: file.getMimeType(),
      url: file.getUrl(),
      carpeta: ruta
    });
  }

  if (!CONFIG.INCLUIR_SUBCARPETAS) return;
  const subs = folder.getFolders();
  while (subs.hasNext()) {
    const sub = subs.next();
    recorrerCarpeta_(sub, ruta + ' / ' + sub.getName(), salida, vistos, carpetasVistas);
  }
}

async function indexarArchivo_(info) {
  const filas = [];
  let status;
  let text = '';
  try {
    if (info.mime === MimeType.GOOGLE_DOCS) {
      text = DocumentApp.openById(info.id).getBody().getText();
    } else if (info.mime === MimeType.PDF || String(info.mime).toLowerCase().indexOf('pdf') !== -1) {
      text = await convertirPdfYExtraerTexto_(DriveApp.getFileById(info.id));
    } else {
      status = 'Omitido: tipo no compatible (' + info.mime + ')';
    }

    if (!status) {
      if (text && text.trim()) {
        const fragmentos = dividirTexto_(limpiarTextoNormativo_(text), CONFIG.CHUNK_CHARS);
        fragmentos.forEach(function(chunk, index) {
          if (esFragmentoIndice_(chunk)) return;
          filas.push([
            info.id, info.nombre, info.mime,
            etiquetaArticulos_(chunk) || 'Fragmento ' + (index + 1),
            chunk, info.url, new Date(), 'Pendiente de verificación'
          ]);
        });
        status = filas.length
          ? 'Texto extraído; ' + filas.length + ' fragmentos' + (INFO_PDF_ ? ' (' + INFO_PDF_ + ')' : '') + '; verificar contenido y vigencia'
          : 'Texto extraído, pero se detectó principalmente índice; revisar PDF/OCR';
      } else {
        status = 'Sin texto extraíble; revisar PDF/OCR';
      }
    }
  } catch (err) {
    status = 'Error: ' + String(err.message || err).slice(0, 300);
  }
  return {
    filas: filas,
    documento: [info.id, info.nombre, info.mime, info.url, info.carpeta, new Date(), status]
  };
}

function ocrBlob_(blob, nombre) {
  if (typeof Drive === 'undefined' || !Drive.Files) {
    throw new Error('Activa el servicio avanzado Drive API en Apps Script > Servicios.');
  }

  let convertedId = '';
  if (typeof Drive.Files.create === 'function') {
    // Drive API v3: crea un Google Doc a partir del PDF.
    const c = Drive.Files.create({
      name: 'TEMP_OCR_' + String(nombre || 'documento').slice(0, 120),
      mimeType: 'application/vnd.google-apps.document'
    }, blob, { ocrLanguage: CONFIG.OCR_LANGUAGE, fields: 'id' });
    convertedId = c && c.id;
  } else if (typeof Drive.Files.insert === 'function') {
    // Compatibilidad con Drive API v2.
    const c = Drive.Files.insert({
      title: 'TEMP_OCR_' + String(nombre || 'documento').slice(0, 120),
      mimeType: 'application/vnd.google-apps.document'
    }, blob, { convert: true, ocr: true, ocrLanguage: CONFIG.OCR_LANGUAGE });
    convertedId = c && c.id;
  }

  if (!convertedId) {
    throw new Error('Drive API no devolvió el ID del documento temporal de OCR.');
  }

  try {
    // La conversión puede tardar más de un segundo. Reintenta abrir el Google Doc
    // antes de declarar fallido el PDF.
    let ultimoError = null;
    for (let intento = 1; intento <= 5; intento++) {
      try {
        const texto = DocumentApp.openById(convertedId).getBody().getText();
        if (texto && texto.trim()) return texto;
        // Un documento vacío puede ser una conversión aún no terminada.
        ultimoError = new Error('La conversión todavía no produjo texto.');
      } catch (e) {
        ultimoError = e;
      }
      if (intento < 5) Utilities.sleep(1000 * intento);
    }
    if (ultimoError) throw new Error('No se pudo leer el documento convertido: ' + String(ultimoError.message || ultimoError));
    return '';
  } finally {
    try {
      DriveApp.getFileById(convertedId).setTrashed(true);
    } catch (e) {
      console.warn('No se pudo eliminar documento temporal ' + convertedId + ': ' + e);
    }
  }
}

function programarContinuacion_() {
  eliminarActivadores_();
  ScriptApp.newTrigger(CONFIG.FUNCION_CONTINUAR).timeBased().after(60 * 1000).create();
}

function eliminarActivadores_() {
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === CONFIG.FUNCION_CONTINUAR) ScriptApp.deleteTrigger(t);
  });
}

/* =========================================================================
 * CATÁLOGO Y CONSULTA (llamadas desde Index.html)
 * ========================================================================= */

/**
 * Devuelve las categorías y documentos de la hoja Documentos que tienen
 * texto indexado. Las categorías sin archivos indexados no se muestran.
 */
function obtenerCatalogoFuentes() {
  const ss = getSpreadsheet_();
  const sheet = ss.getSheetByName(CONFIG.SHEET_DOCUMENTS);
  if (!sheet || sheet.getLastRow() < 2) {
    return {
      ok: true, categorias: [], documentos: [], excluidos: [],
      message: 'No hay documentos indexados todavía. Ejecuta indexarDocumentosDrive() en Apps Script.'
    };
  }

  const meta = leerMetadatosDocumentos_(sheet);
  const docs = [];
  const excluidos = [];
  const categoryCounts = {};
  let verificados = 0;

  Object.keys(meta).forEach(function(id) {
    const m = meta[id];
    if (!m.nombre) return;
    // No se incluyen archivos sin texto o con errores de OCR: se informan aparte
    // para que el usuario sepa qué fuentes no participan en la búsqueda.
    if (!m.disponible) {
      excluidos.push({ nombre: m.nombre, estado: m.estadoDocumento || 'Sin estado', url: m.url });
      return;
    }
    if (m.verificado) verificados++;
    docs.push({
      id: id,
      nombre: m.nombre,
      categoriaId: m.categoriaId,
      categoria: m.categoria,
      carpeta: m.carpeta,
      estado: m.estadoDocumento,
      verificado: m.verificado,
      verificacion: m.verificacion,
      fechaArchivo: m.fechaArchivo,
      url: m.url
    });
    categoryCounts[m.categoriaId] = (categoryCounts[m.categoriaId] || 0) + 1;
  });

  const categories = CATEGORIAS.filter(function(c) {
    return categoryCounts[c.id] > 0;
  }).map(function(c) {
    return { id: c.id, nombre: c.nombre, cantidad: categoryCounts[c.id] };
  });

  docs.sort(function(a, b) { return a.nombre.localeCompare(b.nombre, 'es'); });
  excluidos.sort(function(a, b) { return a.nombre.localeCompare(b.nombre, 'es'); });
  return {
    ok: true,
    categorias: categories,
    documentos: docs,
    verificados: verificados,
    excluidos: excluidos,
    noDisponibles: excluidos.length,
    message: excluidos.length
      ? excluidos.length + ' documento(s) no participan en la búsqueda porque no tienen texto disponible.'
      : ''
  };
}

/**
 * Consulta con filtro y opciones (versión 2026-10-15).
 * filtro: TODAS | ID de categoría (NEC, CONSTITUCION...) | DOC:<ID de Drive>
 * opciones: {
 *   modo: 'TODAS' (todas las palabras, por defecto) | 'FRASE' (frase exacta) | 'CUALQUIERA',
 *   offset: número de resultados ya mostrados (paginación),
 *   limite: resultados por página (máx. 100),
 *   soloVerificadas: true para limitar a fuentes marcadas como verificadas
 * }
 * Las palabras se comparan como palabra completa (admite singular/plural);
 * el texto entre comillas se trata siempre como frase exacta.
 */
function consultarNormativa(pregunta, filtro, opciones) {
  const rawQuestion = String(pregunta || '').trim();
  const filter = String(filtro || 'TODAS').trim();
  const opts = opciones || {};
  const modo = /^(FRASE|CUALQUIERA)$/.test(String(opts.modo || '')) ? String(opts.modo) : 'TODAS';
  const offset = Math.max(0, parseInt(opts.offset, 10) || 0);
  const limite = Math.min(100, Math.max(1, parseInt(opts.limite, 10) || CONFIG.MAX_RESULTS));
  const soloVerificadas = opts.soloVerificadas === true;

  if (normalizar_(rawQuestion).length < 2) {
    return { ok: false, message: 'Escribe un artículo, una norma o palabras clave.' };
  }

  const ss = getSpreadsheet_();
  const articleSheet = ss.getSheetByName(CONFIG.SHEET_ARTICLES);
  const docSheet = ss.getSheetByName(CONFIG.SHEET_DOCUMENTS);
  if (!articleSheet || articleSheet.getLastRow() < 2) {
    return { ok: false, message: 'No hay documentos indexados. Ejecuta indexarDocumentosDrive() desde Apps Script.' };
  }

  const documentMeta = leerMetadatosDocumentos_(docSheet);
  const excluidos = Object.keys(documentMeta)
    .filter(function(id) { return !documentMeta[id].disponible; })
    .map(function(id) { return { nombre: documentMeta[id].nombre, estado: documentMeta[id].estadoDocumento }; });

  const consulta = analizarConsulta_(rawQuestion, modo);
  const exactArticle = detectarArticulo_(rawQuestion);
  if (!exactArticle && !consulta.frases.length && !consulta.terminos.length) {
    return { ok: false, message: 'La consulta solo contiene palabras muy comunes. Agrega términos más específicos.' };
  }

  const values = articleSheet.getRange(2, 1, articleSheet.getLastRow() - 1, 8).getValues();

  // Fecha de última modificación declarada en el texto (portada de Lexis u otras ediciones).
  values.forEach(function(row) {
    const meta = documentMeta[String(row[0] || '')];
    if (!meta || meta.ultimaModificacion) return;
    const m = String(row[4] || '').match(/[ÚU]ltima\s+(?:modificaci[óo]n|reforma)\s*:?\s*([0-9]{1,2}(?:[-\/ ]|\s+de\s+)[A-Za-zÁÉÍÓÚáéíóú.]{3,12}(?:[-\/ ]|\s+de\s+)\.?[0-9]{2,4})/i);
    if (m) meta.ultimaModificacion = m[1].trim();
  });

  // Búsqueda directa de artículo: palabras adicionales que identifican la norma
  // (p. ej. "art. 365 RGLOSNCP") limitan la búsqueda a esos documentos.
  let restriccionDocs = null;
  let avisoRestriccion = '';
  if (exactArticle) {
    const pistas = consulta.terminosLibres.filter(function(t) { return !/^\d/.test(t); });
    if (pistas.length) {
      const candidatos = Object.keys(documentMeta).filter(function(id) {
        return documentoCoincideConPistas_(documentMeta[id], pistas);
      });
      if (candidatos.length) {
        restriccionDocs = new Set(candidatos);
      } else {
        avisoRestriccion = 'No se identificó un documento con "' + pistas.join(' ') + '"; se muestran coincidencias de todas las fuentes. ';
      }
    }
  }

  const scored = [];
  values.forEach(function(row) {
    const id = String(row[0] || '');
    const name = String(row[1] || '');
    const article = String(row[3] || '');
    const text = String(row[4] || '');
    const meta = documentMeta[id] || metaPorDefecto_(name);

    if (filter && filter !== 'TODAS') {
      if (filter.indexOf('DOC:') === 0 && id !== filter.substring(4)) return;
      if (filter.indexOf('DOC:') !== 0 && meta.categoriaId !== filter) return;
    }
    if (restriccionDocs && !restriccionDocs.has(id)) return;
    if (soloVerificadas && !meta.verificado) return;

    const nName = normalizar_(name);
    const nArticle = normalizar_(article);
    const nText = normalizar_(text);
    let score = 0;
    const matched = [];

    if (exactArticle) {
      const enEtiqueta = contieneArticuloExacto_(article, exactArticle);
      const enTexto = enEtiqueta || contieneArticuloExacto_(text, exactArticle);
      if (!enEtiqueta && !enTexto) return;
      // Prioriza el fragmento donde el artículo aparece como encabezado propio.
      const comoEncabezado = encabezadosArticulo_(text).some(function(e) {
        return String(e.numero).toLowerCase() === exactArticle.replace(/^Art[íi]culo\s+/i, '').toLowerCase();
      });
      score = comoEncabezado ? 100 : (enEtiqueta ? 70 : 40);
      matched.push(exactArticle.toLowerCase());
    } else {
      const ev = evaluarFragmento_(consulta, nName, nArticle, nText);
      if (!ev) return;
      score = ev.puntaje;
      Array.prototype.push.apply(matched, ev.coincidencias);
    }

    scored.push({
      score: score,
      idFuente: id,
      documento: name,
      tipo: String(row[2] || ''),
      articulo: article,
      texto: text,
      url: String(row[5] || ''),
      categoriaId: meta.categoriaId,
      categoria: meta.categoria,
      carpeta: meta.carpeta,
      fechaIndexacion: row[6] ? new Date(row[6]).toISOString() : '',
      estadoRevision: meta.verificado ? meta.verificacion : String(row[7] || 'Pendiente de verificación'),
      verificado: !!meta.verificado,
      fechaArchivo: meta.fechaArchivo,
      ultimaModificacion: meta.ultimaModificacion || '',
      palabrasClave: matched
    });
  });

  scored.sort(function(a, b) {
    return b.score - a.score || a.documento.localeCompare(b.documento, 'es') || a.articulo.localeCompare(b.articulo, 'es');
  });

  const maxScore = scored.length ? scored[0].score : 1;
  const grupos = {};
  scored.forEach(function(s) {
    if (!grupos[s.idFuente]) grupos[s.idFuente] = { idFuente: s.idFuente, documento: s.documento, cantidad: 0, mejor: s.score };
    grupos[s.idFuente].cantidad++;
  });
  const porDocumento = Object.keys(grupos).map(function(k) { return grupos[k]; })
    .sort(function(a, b) { return b.mejor - a.mejor || b.cantidad - a.cantidad; })
    .map(function(g) { return { idFuente: g.idFuente, documento: g.documento, cantidad: g.cantidad }; });

  const patrones = consulta.patrones;
  const results = scored.slice(offset, offset + limite).map(function(item) {
    item.relevancia = Math.max(1, Math.round(item.score / maxScore * 100));
    delete item.score;
    enriquecerResultado_(item, exactArticle, patrones);
    return item;
  });

  const descripcionModo = exactArticle ? 'artículo exacto'
    : (modo === 'FRASE' ? 'frase exacta' : (modo === 'CUALQUIERA' ? 'cualquier palabra' : 'todas las palabras'));

  return {
    ok: true,
    pregunta: rawQuestion,
    filtro: filter,
    modo: exactArticle ? 'ARTICULO' : modo,
    descripcionModo: descripcionModo,
    frases: consulta.frases,
    resultados: results,
    offset: offset,
    total: results.length,
    totalCoincidencias: scored.length,
    hayMas: offset + results.length < scored.length,
    porDocumento: porDocumento,
    excluidos: excluidos,
    aviso: avisoRestriccion + (scored.length
      ? (exactArticle
          ? 'Coincidencias del ' + exactArticle + '. Revisa el nombre de la fuente y verifica el texto con el documento oficial.'
          : 'Resultados ordenados por relevancia (' + descripcionModo + '). Verifica siempre la fuente oficial.')
      : (exactArticle
          ? 'No se encontró el ' + exactArticle + ' en los fragmentos indexados para esta fuente. Puede ser necesario revisar la extracción o volver a indexar el documento correspondiente.'
          : (modo === 'TODAS'
              ? 'Ningún fragmento contiene todas las palabras. Prueba el modo «Cualquier palabra» o cambia la fuente.'
              : 'No se encontraron coincidencias. Prueba con otros términos o cambia la fuente.')))
  };
}

/* ---------- Apoyo a la consulta ---------- */

const STOP_WORDS_ = {
  como:1, que:1, para:1, por:1, con:1, del:1, las:1, los:1, una:1, uno:1,
  unos:1, unas:1, de:1, la:1, el:1, y:1, o:1, en:1, al:1, se:1, me:1, mi:1, un:1, es:1,
  sus:1, su:1, entre:1, sobre:1, sin:1, este:1, esta:1, cual:1, cuales:1
};

const ALIAS_NORMAS_ = {
  rglosncp: ['reglamento', 'contratacion publica'],
  losncp: ['ley organica', 'contratacion publica'],
  cre: ['constitucion'],
  constitucion: ['constitucion'],
  coip: ['coip|codigo organico integral penal'],
  cootad: ['cootad|organizacion territorial'],
  losep: ['losep|servicio publico'],
  cogep: ['cogep|codigo organico general de procesos'],
  coa: ['codigo organico administrativo'],
  nec: ['nec|norma ecuatoriana de la construccion'],
  loscca: ['contraloria'],
  locge: ['contraloria']
};

function escaparRegex_(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Variantes singular/plural de un término normalizado. */
function variantesTermino_(t) {
  const v = [t];
  if (t.length > 4 && /es$/.test(t)) v.push(t.slice(0, -2));
  if (t.length > 3 && /s$/.test(t)) v.push(t.slice(0, -1));
  return v;
}

/** Patrón de palabra completa (admite plural) sobre texto normalizado. */
function patronTermino_(t) {
  const base = variantesTermino_(t).map(escaparRegex_).join('|');
  return '(?<![\\p{L}\\p{N}])(?:' + base + ')(?:es|s)?(?![\\p{L}\\p{N}])';
}

/** Patrón de frase exacta: palabras consecutivas, separadas por espacios o signos. */
function patronFrase_(frase) {
  return '(?<![\\p{L}\\p{N}])' + frase.split(' ').map(escaparRegex_).join('[^\\p{L}\\p{N}]+') + '(?![\\p{L}\\p{N}])';
}

function analizarConsulta_(raw, modo) {
  const frases = [];
  let resto = String(raw || '').replace(/["“”«»]([^"“”«»]+)["“”«»]/g, function(_, f) {
    const n = normalizar_(f).replace(/[.-]/g, ' ').replace(/\s+/g, ' ').trim();
    if (n) frases.push(n);
    return ' ';
  });
  const terminosLibres = normalizar_(resto).replace(/[.-]/g, ' ').split(/\s+/).filter(function(t) {
    return t && !STOP_WORDS_[t] && t !== 'articulo' && t !== 'art';
  });
  let terminos = terminosLibres.filter(function(t) { return t.length > 2 || /^\d+$/.test(t); });

  if (modo === 'FRASE' && !frases.length) {
    const f = normalizar_(resto).replace(/[.-]/g, ' ').replace(/\s+/g, ' ').trim();
    if (f) frases.push(f);
    terminos = [];
  }

  const patrones = [];
  frases.forEach(function(f) { patrones.push({ tipo: 'frase', texto: f, re: patronFrase_(f) }); });
  terminos.forEach(function(t) { patrones.push({ tipo: 'termino', texto: t, re: patronTermino_(t) }); });

  // Frase implícita: la consulta completa como texto continuo suma relevancia.
  const fraseImplicita = terminos.length > 1 ? terminosLibres.join(' ') : '';

  return {
    modo: modo,
    frases: frases,
    terminos: terminos,
    terminosLibres: terminosLibres,
    patrones: patrones,
    fraseImplicita: fraseImplicita ? patronFrase_(fraseImplicita) : ''
  };
}

function posiciones_(texto, patron) {
  const re = typeof patron === 'string' ? new RegExp(patron, 'gu') : patron;
  re.lastIndex = 0;
  const out = [];
  let m;
  while ((m = re.exec(texto)) !== null && out.length < 200) {
    out.push(m.index);
    if (!m[0]) re.lastIndex++;
  }
  return out;
}

/** Menor distancia (en caracteres) que contiene una aparición de cada término. */
function ventanaMinima_(listas) {
  const eventos = [];
  listas.forEach(function(l, k) { l.forEach(function(p) { eventos.push([p, k]); }); });
  eventos.sort(function(a, b) { return a[0] - b[0]; });
  const cuenta = {};
  let distintos = 0;
  let ini = 0;
  let mejor = Infinity;
  for (let fin = 0; fin < eventos.length; fin++) {
    const k = eventos[fin][1];
    if (!cuenta[k]) distintos++;
    cuenta[k] = (cuenta[k] || 0) + 1;
    while (distintos === listas.length) {
      mejor = Math.min(mejor, eventos[fin][0] - eventos[ini][0]);
      const ki = eventos[ini][1];
      cuenta[ki]--;
      if (!cuenta[ki]) distintos--;
      ini++;
    }
  }
  return mejor;
}

/**
 * Evalúa un fragmento. Devuelve null si no cumple el modo de búsqueda.
 * Puntaje: cobertura de términos, frase completa, cercanía entre términos,
 * frecuencia (con tope) y presencia en la etiqueta de artículo o en el nombre.
 */
function evaluarFragmento_(consulta, nName, nArticle, nText) {
  const patrones = consulta.patrones;
  if (!patrones.length) return null;
  let puntaje = 0;
  const coincidencias = [];
  const listasTexto = [];
  let cumplidos = 0;

  patrones.forEach(function(p) {
    if (!p.reG) { p.reG = new RegExp(p.re, 'gu'); p.reU = new RegExp(p.re, 'u'); }
    const enTexto = posiciones_(nText, p.reG);
    const enNombre = p.reU.test(nName);
    const enArticulo = p.reU.test(nArticle);
    if (!enTexto.length && !enNombre && !enArticulo) return;
    cumplidos++;
    coincidencias.push(p.texto);
    const pesoFrase = p.tipo === 'frase' ? 3 : 1;
    puntaje += (enTexto.length ? 10 + Math.min(12, 4 * Math.log2(1 + enTexto.length)) : 0) * pesoFrase;
    puntaje += (enNombre ? 6 : 0) + (enArticulo ? 6 : 0);
    if (enTexto.length) listasTexto.push(enTexto);
  });

  if (!cumplidos) return null;
  if (consulta.modo !== 'CUALQUIERA' && cumplidos < patrones.length) return null;

  puntaje += 30 * cumplidos / patrones.length;
  if (consulta.fraseImplicita) {
    if (!consulta.reImplicita) consulta.reImplicita = new RegExp(consulta.fraseImplicita, 'u');
    if (consulta.reImplicita.test(nText)) puntaje += 40;
  }
  if (listasTexto.length > 1) {
    const v = ventanaMinima_(listasTexto);
    if (v <= 60) puntaje += 25;
    else if (v <= 250) puntaje += 15;
    else if (v <= 800) puntaje += 5;
  }
  return { puntaje: puntaje, coincidencias: coincidencias };
}

function documentoCoincideConPistas_(meta, pistas) {
  const nombre = normalizar_(meta.nombre + ' ' + meta.carpeta);
  return pistas.every(function(p) {
    const alias = ALIAS_NORMAS_[p];
    if (alias) return alias.every(function(a) { return new RegExp(a).test(nombre); });
    return new RegExp(patronTermino_(p), 'u').test(nombre);
  });
}

function metaPorDefecto_(name) {
  const cat = clasificarDocumento_(name, '');
  return {
    nombre: name, categoriaId: cat.id, categoria: cat.nombre, carpeta: '', estadoDocumento: '',
    disponible: true, verificado: false, verificacion: '', fechaArchivo: fechaEnNombre_(name), ultimaModificacion: ''
  };
}

/** Fecha incluida en el nombre del archivo (AAAA-MM-DD o DD-MM-AAAA). */
function fechaEnNombre_(nombre) {
  const s = String(nombre || '');
  let m = s.match(/(20\d{2}|19\d{2})[-_.](\d{2})[-_.](\d{2})/);
  if (m) return m[1] + '-' + m[2] + '-' + m[3];
  m = s.match(/(\d{2})[-_.](\d{2})[-_.](20\d{2}|19\d{2})/);
  if (m) return m[3] + '-' + m[2] + '-' + m[1];
  return '';
}

function estadoDisponible_(estado) {
  return /^Texto extraído\s*(?:;|\()/i.test(estado)
    && !/principalmente índice|sin texto|error|omitido/i.test(estado);
}

/**
 * Lee la hoja Documentos. La columna 8 ("Verificación") la completa el
 * administrador a mano: un valor que empiece por "Verificado" marca la fuente
 * como verificada (p. ej. "Verificado 2026-10-15 – texto cotejado con RO").
 */
function leerMetadatosDocumentos_(docSheet) {
  const out = {};
  if (!docSheet || docSheet.getLastRow() < 2) return out;
  const ancho = Math.min(8, Math.max(7, docSheet.getLastColumn()));
  docSheet.getRange(2, 1, docSheet.getLastRow() - 1, ancho).getDisplayValues().forEach(function(row) {
    if (!row[0]) return;
    const cat = clasificarDocumento_(row[1], row[4]);
    const verif = String(row[7] || '').trim();
    const estado = String(row[6] || '');
    out[String(row[0])] = {
      nombre: String(row[1] || ''),
      categoriaId: cat.id,
      categoria: cat.nombre,
      carpeta: String(row[4] || ''),
      url: String(row[3] || ''),
      estadoDocumento: estado,
      disponible: estadoDisponible_(estado),
      verificado: /^verificad[oa]/i.test(verif),
      verificacion: verif,
      fechaArchivo: fechaEnNombre_(row[1]),
      ultimaModificacion: ''
    };
  });
  return out;
}

/* =========================================================================
 * UTILIDADES
 * ========================================================================= */

/**
 * Comprueba un número de artículo exacto.
 * - Evita "Art. 260" cuando se busca "Art. 26".
 * - Acepta el formato ecuatoriano "Art. 26.-" y "Art. 26." al final de frase.
 * - Evita "Art. 26.1" y "Art. 26A" cuando se busca "Art. 26".
 */
function contieneArticuloExacto_(texto, etiquetaArticulo) {
  const numero = normalizar_(String(etiquetaArticulo || '').replace(/^art[íi]culo\s*/i, '')).trim();
  if (!numero) return false;
  const escaped = numero.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const normalized = normalizar_(texto);
  const pattern = new RegExp(
    '(?:^|[^a-z])(?:articulo|art)\\.?\\s*(?:numero\\s*|no\\.?\\s*)?' + escaped + '(?![0-9a-z])(?![.-][0-9])',
    'i'
  );
  return pattern.test(normalized);
}

function clasificarDocumento_(nombre, carpeta) {
  const n = normalizar_([nombre, carpeta].join(' '));

  // Prioridad específica antes que general.
  if (/constitucion|reforma constitucional|enmienda constitucional/.test(n)) {
    return { id: 'CONSTITUCION', nombre: 'Constitución y normativa constitucional' };
  }
  if (/norma ecuatoriana de la construccion|\bnec\b|normas tecnicas nec|capitulo nec/.test(n)) {
    return { id: 'NEC', nombre: 'Construcción — NEC' };
  }
  if (/sercop|losncp|contratacion publica|compras publicas/.test(n)) {
    return { id: 'CONTRATACION', nombre: 'Contratación pública — SERCOP' };
  }
  if (/contraloria|control interno|normas de control/.test(n)) {
    return { id: 'CONTROL', nombre: 'Control público — Contraloría' };
  }
  if (/discapacidad|accesibilidad universal|personas con discapacidad/.test(n)) {
    return { id: 'DISCAPACIDAD', nombre: 'Accesibilidad y discapacidad' };
  }
  if (/losep|servicio publico|administracion publica|servidor publico/.test(n)) {
    return { id: 'SERVICIO_PUBLICO', nombre: 'Administración pública y servicio público' };
  }
  if (/cootad|ordenamiento territorial|uso y gestion del suelo|ordenanza|municipal|urbanismo/.test(n)) {
    return { id: 'URBANISMO', nombre: 'Urbanismo y ordenamiento territorial' };
  }
  if (/inen|norma tecnica ecuatoriana/.test(n)) {
    return { id: 'INEN', nombre: 'Normas técnicas INEN' };
  }
  if (/ambiental|medio ambiente|seguridad y salud|riesgos laborales|seguridad ocupacional/.test(n)) {
    return { id: 'AMBIENTE_SEGURIDAD', nombre: 'Ambiente y seguridad ocupacional' };
  }
  if (/reglamento|decreto ejecutivo|acuerdo ministerial/.test(n)) {
    return { id: 'REGLAMENTOS', nombre: 'Reglamentos, decretos y acuerdos' };
  }
  if (/resolucion/.test(n)) {
    return { id: 'RESOLUCIONES', nombre: 'Resoluciones y normativa institucional' };
  }
  if (/manual|especificacion|ficha tecnica|guia tecnica|guia practica/.test(n)) {
    return { id: 'MANUALES', nombre: 'Manuales y especificaciones técnicas' };
  }
  if (/codigo civil|coip|codigo organico|cogep/.test(n)) {
    return { id: 'CODIGOS', nombre: 'Códigos y legislación general' };
  }
  if (/ley organica|ley ordinaria|^ley | ley /.test(n)) {
    return { id: 'LEYES', nombre: 'Leyes orgánicas y ordinarias' };
  }
  return { id: 'OTROS', nombre: 'Otros documentos indexados' };
}

function diagnosticoConfiguracion() {
  const ss = getSpreadsheet_();
  const carpetas = CONFIG.FOLDER_IDS.map(function(id) {
    try {
      const f = DriveApp.getFolderById(id);
      return { id: id, nombre: f.getName(), acceso: 'OK' };
    } catch (e) {
      return { id: id, acceso: 'ERROR: ' + e.message };
    }
  });
  const archivos = listarArchivosConfigurados_();
  const resultado = {
    proyecto: ScriptApp.getScriptId(),
    spreadsheetUrl: ss.getUrl(),
    hojas: ss.getSheets().map(function(s) { return s.getName(); }),
    carpetas: carpetas,
    archivosEncontrados: archivos.length,
    archivos: archivos.map(function(a) { return a.carpeta + ' / ' + a.nombre; }),
    driveApi: (typeof Drive !== 'undefined' && Drive.Files)
      ? (typeof Drive.Files.create === 'function' ? 'v3 activa' : 'v2 activa')
      : 'NO ACTIVADA'
  };
  console.log(JSON.stringify(resultado, null, 2));
  return resultado;
}

function getSpreadsheet_() {
  const id = String(CONFIG.SPREADSHEET_ID || '').trim();
  if (!id || id === 'PEGAR_AQUI_ID_DEL_GOOGLE_SHEETS') {
    throw new Error('CONFIG.SPREADSHEET_ID está vacío o contiene el texto de ejemplo.');
  }
  return SpreadsheetApp.openById(id);
}

function validarConfiguracion_() {
  getSpreadsheet_();
  if (typeof Drive === 'undefined' || !Drive.Files) {
    throw new Error('Activa el servicio avanzado Drive API: Apps Script > Servicios > + > Drive API.');
  }
}

function getOrCreateSheet_(ss, name, headers) {
  let sheet = ss.getSheetByName(name);
  if (!sheet) sheet = ss.insertSheet(name);
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold');
  } else {
    // Agrega encabezados nuevos (p. ej. "Verificación") sin tocar los datos.
    const actuales = sheet.getRange(1, 1, 1, headers.length).getValues()[0];
    headers.forEach(function(h, k) {
      if (!String(actuales[k] || '').trim()) {
        sheet.getRange(1, k + 1).setValue(h).setFontWeight('bold');
      }
    });
  }
  return sheet;
}

function reiniciarHoja_(sheet, headers) {
  sheet.clear();
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  sheet.setFrozenRows(1);
  sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold');
}

function replaceSheetBody_(sheet, rows, width) {
  if (sheet.getLastRow() > 1) {
    sheet.getRange(2, 1, sheet.getLastRow() - 1, width).clearContent();
  }
  if (rows.length) sheet.getRange(2, 1, rows.length, width).setValues(rows);
}

/**
 * Divide el texto en fragmentos de hasta maxChars, cortando de preferencia
 * justo antes del inicio de un artículo ("Art." / "Artículo") o en un salto
 * de párrafo, para no partir artículos.
 */
function dividirTexto_(text, maxChars) {
  const clean = String(text || '').replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').trim();
  const chunks = [];
  const reArticulo = /\n\s*(?:Art[íi]culo|ART[ÍI]CULO|Art\.|ART\.)\s*\d/g;
  let pos = 0;
  while (pos < clean.length) {
    if (clean.length - pos <= maxChars) {
      chunks.push(clean.slice(pos).trim());
      break;
    }
    const ventana = clean.slice(pos, pos + maxChars);
    const minimo = Math.floor(maxChars * 0.5);
    let corte = -1;

    reArticulo.lastIndex = 0;
    let m;
    while ((m = reArticulo.exec(ventana)) !== null) {
      if (m.index >= minimo) corte = m.index;
    }
    if (corte === -1) {
      const p = ventana.lastIndexOf('\n\n');
      if (p >= minimo) corte = p;
    }
    if (corte === -1) {
      const l = ventana.lastIndexOf('\n');
      if (l >= minimo) corte = l;
    }
    if (corte === -1) corte = maxChars;

    const trozo = clean.slice(pos, pos + corte).trim();
    if (trozo) chunks.push(trozo);
    pos += corte;
  }
  return chunks.filter(Boolean);
}

/**
 * Limpia encabezados/pies repetidos del Registro Oficial y artefactos de OCR.
 * Solo elimina líneas completas reconocibles como metadatos de página.
 */
function limpiarTextoNormativo_(text) {
  return limpiarEncabezadosPies_(String(text || ''))
    .split('\n')
    .filter(function(line) {
      const t = String(line || '').trim();
      if (!t) return true;
      if (/^(índice|indice|contenido|tabla de contenido|índice de tablas|indice de tablas|índice de figuras|indice de figuras)$/i.test(t)) return false;
      if (/.{3,}\.{4,}\s*\d{1,4}\s*$/.test(t)) return false;
      return true;
    })
    .join('\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Quita metadatos de página que se insertan en mitad de los artículos al
 * extraer PDF multipágina. No elimina menciones del Registro Oficial dentro
 * de un párrafo: actúa solo sobre líneas independientes.
 */
function limpiarEncabezadosPies_(texto) {
  return String(texto || '')
    .replace(/\r/g, '')
    .split('\n')
    .filter(function(linea) {
      const t = String(linea || '').replace(/\s+/g, ' ').trim();
      if (!t) return true;

      // Encabezados/pies recurrentes de publicaciones oficiales.
      if (/^Registro Oficial\s*[-–—:]?\s*(?:Cuarto|Tercer|Segundo|Primer)?\s*Suplemento\b.*$/i.test(t)) return false;
      if (/^(?:Cuarto|Tercer|Segundo|Primer)\s+Suplemento\s*(?:N[.º°o]?\s*)?\d*\s*[-–—:].*$/i.test(t)) return false;
      if (/^(?:Edici[oó]n|Suplemento)\s+(?:Especial\s+)?N[.º°o]?\s*\d+.*Registro Oficial.*$/i.test(t)) return false;

      // Fechas aisladas habituales del encabezado del Registro Oficial.
      if (/^(?:lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo)\s+\d{1,2}\s+de\s+[a-záéíóúñ]+\s+de\s+\d{4}$/i.test(t)) return false;

      // Número de página aislado (ej. "38", "41").
      if (/^\d{1,4}$/.test(t)) return false;

      // Folios aislados del tipo "Página 38", "Pág. 38 de 94".
      if (/^(?:p[aá]gina|p[aá]g\.?)\s*\d{1,4}(?:\s+de\s+\d{1,4})?$/i.test(t)) return false;

      return true;
    })
    .join('\n');
}
function esFragmentoIndice_(text) {
  const lines = String(text || '').split('\n').map(function(x) { return x.trim(); }).filter(Boolean);
  if (lines.length < 3) return false;
  let tocLines = 0;
  lines.forEach(function(line) {
    if (/.{3,}\.{4,}\s*\d{1,4}\s*$/.test(line) ||
        /^(índice|indice|contenido|tabla de contenido|índice de tablas|índice de figuras)$/i.test(line)) tocLines++;
  });
  return tocLines / lines.length >= 0.25;
}

/** Detecta el primer artículo mencionado (se usa sobre la pregunta del usuario). */
function detectarArticulo_(text) {
  const normalized = normalizar_(text);
  const match = normalized.match(/(?:^|[^a-z])(?:articulo|art)\.?\s*(?:numero\s*|no\.?\s*)?(\d+[a-z]?(?:[-.]\d+)*)(?![0-9])/i);
  if (!match) return '';
  const numero = match[1].replace(/[.-]$/, '');
  return 'Artículo ' + numero;
}

/**
 * Etiqueta del fragmento: primer y último artículo encabezado en el fragmento,
 * p. ej. "Artículo 10 – Artículo 18".
 */
function etiquetaArticulos_(chunk) {
  const normalized = normalizar_(chunk);
  const re = /(?:^|\n|\s)(?:articulo|art)\.?\s*(\d+[a-z]?)(?:\.-|\.|-|\s)/g;
  const numeros = [];
  let m;
  while ((m = re.exec(normalized)) !== null) numeros.push(m[1]);
  if (!numeros.length) return '';
  const primero = numeros[0];
  const ultimo = numeros[numeros.length - 1];
  return primero === ultimo ? 'Artículo ' + primero : 'Artículo ' + primero + ' – Artículo ' + ultimo;
}

function normalizar_(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}\s.-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/* =====================================================================
 * MEJORAS DE RESULTADOS (2026-10-13)
 * - Extracto del artículo que contiene la coincidencia (no el inicio del fragmento).
 * - Página según el pie "Página N de M" del propio documento.
 * - Etiqueta de artículos basada solo en encabezados reales ("Art. 28.-"),
 *   ignorando referencias internas como "sustituido por artículo 3 de Ley...".
 * - Puntaje adicional por frecuencia del término.
 * ===================================================================== */

function encabezadosArticulo_(texto) {
  // Solo encabezados al comienzo de una línea; acepta "Artículo 56.",
  // "Artículo 56.-", "Art. 56.-" y variaciones habituales de OCR.
  const re = /(^|\n)[ \t]*(?:Art[íi]culo|ART[ÍI]CULO|Art\.|ART\.)[ \t]*(\d+(?:\.\d+)*[a-z]?)[ \t]*(?:\.-|\.–|\.—|-|–|—|\.|:)/g;
  const lista = [];
  let m;
  while ((m = re.exec(texto)) !== null) {
    lista.push({ index: m.index + m[1].length, numero: m[2] });
  }
  return lista;
}

function etiquetaDesdeEncabezados_(enc) {
  if (!enc.length) return '';
  const a = enc[0].numero;
  const b = enc[enc.length - 1].numero;
  return a === b ? 'Artículo ' + a : 'Artículo ' + a + ' – Artículo ' + b;
}

function normalizarPosicional_(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i].toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    out += c ? c[0] : ' ';
  }
  return out;
}

function contarOcurrencias_(texto, termino) {
  let n = 0;
  let p = texto.indexOf(termino);
  while (p !== -1 && n < 10) { n++; p = texto.indexOf(termino, p + termino.length); }
  return n;
}

function paginaSegunPie_(texto, pos) {
  const re = /P[áa]g(?:ina)?\.?\s*(\d{1,4})(?:\s+de\s+(\d{1,4}))?/gi;
  let m;
  let previa = null;
  while ((m = re.exec(texto)) !== null) {
    if (m.index >= pos) return 'Pág. ' + m[1] + (m[2] ? ' de ' + m[2] : '');
    previa = m;
  }
  if (previa) {
    const n = Number(previa[1]) + 1;
    const t = previa[2] ? Number(previa[2]) : 0;
    if (!t) return 'Pág. ' + n;
    if (n <= t) return 'Pág. ' + n + ' de ' + t;
  }
  return '';
}

/**
 * Prepara el resultado para mostrar:
 * - limpia encabezados/pies repetidos del Registro Oficial;
 * - si la pregunta solicita un artículo exacto, devuelve SOLO ese artículo,
 *   incluso si el fragmento indexado contiene varios artículos;
 * - une el texto del artículo a través de saltos de página, sin los folios.
 */

/**
 * Retira encabezados estructurales que pertenecen al apartado siguiente y que
 * quedaron pegados al final del artículo por la extracción/segmentación del PDF.
 * Es deliberadamente conservador: solo recorta si el encabezado aparece en una
 * línea propia y al final del cuerpo, nunca dentro de un párrafo.
 */
function quitarEncabezadoPosterior_(texto) {
  let salida = String(texto || '').replace(/\r/g, '').trim();
  const lineas = salida.split('\n');

  // Los encabezados suelen aparecer como "Sección octava" seguido del título.
  // Si se detecta uno en las últimas líneas, elimina desde ahí hasta el final.
  const reEstructura = /^\s*(?:LIBRO|T[IÍ]TULO|CAP[IÍ]TULO|SECCI[ÓO]N|PARTE)\s+(?:[IVXLCDM]+|\d+|primera|segunda|tercera|cuarta|quinta|sexta|s[eé]ptima|octava|novena|d[eé]cima|[a-záéíóúñ -]{1,35})\s*$/i;
  let indice = -1;
  for (let i = Math.max(0, lineas.length - 8); i < lineas.length; i++) {
    if (reEstructura.test(lineas[i])) {
      indice = i;
      break;
    }
  }
  if (indice >= 0) {
    salida = lineas.slice(0, indice).join('\n').trim();
  }
  return salida;
}

/**
 * Limpieza para mostrar (no se aplica al índice, para no perder los folios
 * que sirven para calcular la página). Además de lo que retira
 * limpiarEncabezadosPies_, quita líneas de encabezado/pie editorial como
 * "REGLAMENTO DE LA LEY ... Página 180 de 223", "CÓDIGO ... - Página 113" y
 * "LEXIS FINDER - www.lexis.com.ec". Devuelve el texto limpio y una función
 * que traduce una posición del texto limpio a la posición en el original.
 */
function limpiarParaMostrarConMapa_(original) {
  const texto = String(original || '').replace(/\r/g, '');
  const lineas = texto.split('\n');
  const partes = [];
  const iniciosLimpio = [];
  const iniciosOriginal = [];
  let posOriginal = 0;
  let largoLimpio = 0;
  let blancoPrevio = true;

  lineas.forEach(function(linea) {
    const inicio = posOriginal;
    posOriginal += linea.length + 1;
    const t = linea.replace(/\s+/g, ' ').trim();
    if (!t) {
      if (blancoPrevio) return;
      blancoPrevio = true;
    } else {
      if (esLineaEditorial_(t)) return;
      blancoPrevio = false;
    }
    const conservada = linea.replace(/\s+$/, '');
    if (partes.length) largoLimpio += 1; // salto de línea
    iniciosLimpio.push(largoLimpio);
    iniciosOriginal.push(inicio);
    partes.push(conservada);
    largoLimpio += conservada.length;
  });

  const limpio = partes.join('\n');
  function aOriginal(pos) {
    let lo = 0;
    let hi = iniciosLimpio.length - 1;
    if (hi < 0) return 0;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (iniciosLimpio[mid] <= pos) lo = mid; else hi = mid - 1;
    }
    return iniciosOriginal[lo] + Math.max(0, pos - iniciosLimpio[lo]);
  }
  return { texto: limpio, aOriginal: aOriginal };
}

function esLineaEditorial_(t) {
  if (/^Registro Oficial\s*[-–—:]?\s*(?:Cuarto|Tercer|Segundo|Primer)?\s*Suplemento\b/i.test(t)) return true;
  if (/^(?:Cuarto|Tercer|Segundo|Primer)\s+Suplemento\s*(?:N[.º°o]?\s*)?\d*\s*[-–—:]/i.test(t)) return true;
  if (/^(?:Edici[oó]n|Suplemento)\s+(?:Especial\s+)?N[.º°o]?\s*\d+.*Registro Oficial/i.test(t)) return true;
  if (/^(?:lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo)\s+\d{1,2}\s+de\s+[a-záéíóúñ]+\s+de\s+\d{4}$/i.test(t)) return true;
  if (/^\d{1,4}$/.test(t)) return true;
  if (/^\d{1,4}\s*\/\s*\d{1,4}$/.test(t)) return true;
  if (/^(?:p[aá]gina|p[aá]g\.?)\s*\d{1,4}(?:\s+de\s+\d{1,4})?$/i.test(t)) return true;
  // Título de la norma seguido del folio: "... Página 180 de 223" / "... - Página 113".
  if (t.length <= 200) {
    const m = t.match(/^(.*?)\s*P[áa]gina\s*\d{1,4}(?:\s+de\s+\d{1,4})?$/i);
    if (m) {
      const antes = m[1].trim();
      // Solo si lo previo es un título en mayúsculas o termina en guion.
      if (!antes || /[-–—]$/.test(antes) || antes === antes.toLocaleUpperCase('es')) return true;
    }
  }
  if (/^LEXIS\s+FINDER\b/i.test(t)) return true;
  if (/^(?:www\.|https?:\/\/)\S+$/i.test(t)) return true;
  return false;
}

/**
 * Prepara el resultado para mostrar:
 * - limpia encabezados/pies editoriales;
 * - si la pregunta solicita un artículo exacto, devuelve SOLO ese artículo;
 * - en búsquedas temáticas, muestra el artículo que mejor coincide;
 * - calcula la página donde está la coincidencia y el rango de páginas del
 *   extracto, a partir de los folios impresos en el propio documento.
 */
function enriquecerResultado_(item, exactArticle, patrones) {
  const textoOriginal = String(item.texto || '');
  if (!textoOriginal) return item;

  const limpieza = limpiarParaMostrarConMapa_(textoOriginal);
  const texto = limpieza.texto;

  const enc = encabezadosArticulo_(texto);
  const etiqueta = etiquetaDesdeEncabezados_(enc);
  if (etiqueta) item.articulo = etiqueta;

  function contextoAntesDe_(posicion) {
    const antes = texto.slice(0, Math.max(0, posicion));
    const lineas = antes.split('\n');
    const reContexto = /^\s*(TÍTULO|TITULO|CAPÍTULO|CAPITULO|SECCIÓN|SECCION|LIBRO|PARTE)\s+([^\n]{1,180})\s*$/i;
    let ultimo = '';
    for (let i = 0; i < lineas.length; i++) {
      const linea = String(lineas[i] || '').trim();
      const m = linea.match(reContexto);
      if (!m) continue;
      const partes = [linea];
      const siguiente = String(lineas[i + 1] || '').trim();
      const pareceTitulo = siguiente && siguiente.length <= 180 &&
        !/^(?:Art(?:ículo|\.)?\s*\d+|CONCORDANCIAS:?|CONCORDANCIA:?|JURISPRUDENCIA:?|LIBRO\b|T[IÍ]TULO\b|CAP[IÍ]TULO\b|SECCI[ÓO]N\b|PARTE\b)/i.test(siguiente);
      if (pareceTitulo) partes.push(siguiente);
      ultimo = partes.join('\n');
    }
    return ultimo;
  }

  const cortes = enc.map(function(e) { return e.index; });
  if (!cortes.length || cortes[0] > 0) cortes.unshift(0);
  const segmentos = cortes.map(function(ini, k) {
    return { ini: ini, fin: k + 1 < cortes.length ? cortes[k + 1] : texto.length };
  });

  let mejor = null;
  if (exactArticle) {
    const num = String(exactArticle).replace(/^Art[íi]culo\s+/i, '').toLowerCase();
    for (let k = 0; k < segmentos.length; k++) {
      const e = enc.filter(function(x) { return x.index === segmentos[k].ini; })[0];
      if (e && String(e.numero).toLowerCase() === num) {
        mejor = { ini: segmentos[k].ini, fin: segmentos[k].fin, pos: segmentos[k].ini };
        break;
      }
    }
    if (!mejor) {
      // El artículo se menciona dentro de otro: se ubica la mención.
      const norm = normalizarPosicional_(texto);
      const re = new RegExp('(?:articulo|art)\\.?\\s*' + escaparRegex_(num) + '(?![0-9a-z])', 'i');
      const m = re.exec(norm);
      if (m) {
        const sg = segmentos.filter(function(x) { return x.ini <= m.index && m.index < x.fin; })[0];
        if (sg) mejor = { ini: sg.ini, fin: sg.fin, pos: m.index };
      }
    }
  } else if (patrones && patrones.length) {
    const norm = normalizarPosicional_(texto);
    let mejorPuntaje = 0;
    segmentos.forEach(function(sg) {
      const trozo = norm.slice(sg.ini, sg.fin);
      let distintos = 0;
      let total = 0;
      let primera = -1;
      patrones.forEach(function(p) {
        const pos = posiciones_(trozo, p.re);
        if (!pos.length) return;
        distintos += p.tipo === 'frase' ? 3 : 1;
        total += Math.min(10, pos.length);
        if (primera === -1 || pos[0] < primera) primera = pos[0];
      });
      const puntaje = distintos * 100 + total;
      if (puntaje > mejorPuntaje) {
        mejorPuntaje = puntaje;
        mejor = { ini: sg.ini, fin: sg.fin, pos: sg.ini + Math.max(primera, 0) };
      }
    });
  }

  item.paginaNota = 'según el folio impreso en el documento';
  if (mejor) {
    item.contextoNormativo = contextoAntesDe_(mejor.ini);
    let cuerpo = quitarEncabezadoPosterior_(texto.slice(mejor.ini, mejor.fin).trim());
    const encSeg = enc.filter(function(e) { return e.index === mejor.ini; })[0];
    if (encSeg) {
      item.articuloCoincidente = 'Artículo ' + encSeg.numero;
      item.articulo = 'Artículo ' + encSeg.numero;
    }
    if (cuerpo) {
      item.extracto = cuerpo;
    }
    item.pagina = paginaSegunPie_(textoOriginal, limpieza.aOriginal(mejor.pos));
    item.paginaInicio = paginaSegunPie_(textoOriginal, limpieza.aOriginal(mejor.ini));
    item.paginaFin = paginaSegunPie_(textoOriginal, limpieza.aOriginal(Math.max(mejor.ini, mejor.fin - 1)));
  } else {
    item.contextoNormativo = contextoAntesDe_(0);
    item.extracto = texto.length > 3000 ? texto.slice(0, 3000).trim() + ' …' : texto;
    item.pagina = paginaSegunPie_(textoOriginal, 0);
    item.paginaInicio = item.pagina;
    item.paginaFin = paginaSegunPie_(textoOriginal, Math.max(0, textoOriginal.length - 1));
  }
  // El fragmento completo también se entrega limpio.
  item.texto = texto;
  return item;
}

/* =====================================================================
 * PDF DE MÁS DE 80 PÁGINAS (2026-10-13)
 * La conversión OCR de Drive (PDF -> Google Docs) solo procesa las primeras
 * 80 páginas. Se divide el PDF en tramos con pdf-lib antes del OCR y se unen
 * los textos en orden.
 * ===================================================================== */

var INFO_PDF_ = '';

function cargarPdfLib_() {
  if (typeof globalThis.PDFLib !== 'undefined') return globalThis.PDFLib;
  if (typeof globalThis.setTimeout === 'undefined') {
    globalThis.setTimeout = function(fn) { fn(); return 0; };
  }
  const codigo = UrlFetchApp.fetch(CONFIG.PDF_LIB_URL).getContentText();
  (0, eval)(codigo);
  return globalThis.PDFLib;
}

async function contarPaginasPdf_(blob) {
  const PDFLib = cargarPdfLib_();
  const doc = await PDFLib.PDFDocument.load(new Uint8Array(blob.getBytes()), { ignoreEncryption: true });
  return doc.getPageCount();
}

async function dividirPdfEnTramos_(blob, maxPaginas) {
  const PDFLib = cargarPdfLib_();
  const origen = await PDFLib.PDFDocument.load(new Uint8Array(blob.getBytes()), { ignoreEncryption: true });
  const total = origen.getPageCount();
  if (total <= maxPaginas) return { total: total, partes: [blob] };
  const partes = [];
  for (let ini = 0; ini < total; ini += maxPaginas) {
    const doc = await PDFLib.PDFDocument.create();
    const indices = [];
    for (let p = ini; p < Math.min(total, ini + maxPaginas); p++) indices.push(p);
    const paginas = await doc.copyPages(origen, indices);
    paginas.forEach(function(pg) { doc.addPage(pg); });
    const bytes = await doc.save();
    partes.push(Utilities.newBlob(Array.from(new Int8Array(bytes)), MimeType.PDF, 'tramo_' + (partes.length + 1) + '.pdf'));
  }
  return { total: total, partes: partes };
}

async function convertirPdfYExtraerTexto_(file) {
  INFO_PDF_ = '';
  const blob = file.getBlob();
  let division;
  try {
    division = await dividirPdfEnTramos_(blob, CONFIG.OCR_MAX_PAGINAS);
  } catch (e) {
    console.warn('No se pudo dividir el PDF (' + file.getName() + '): ' + e);
    INFO_PDF_ = 'sin dividir; si supera 80 páginas el texto puede estar incompleto';
    return ocrBlob_(blob, file.getName());
  }
  const fallidos = [];
  const textos = [];
  for (let k = 0; k < division.partes.length; k++) {
    const desde = k * CONFIG.OCR_MAX_PAGINAS + 1;
    const hasta = Math.min(division.total, desde + CONFIG.OCR_MAX_PAGINAS - 1);
    const nombre = file.getName() + (division.partes.length > 1 ? ' - parte ' + (k + 1) : '');
    textos.push(await ocrConReintento_(division.partes[k], nombre, desde, hasta, fallidos));
  }
  INFO_PDF_ = division.total + ' páginas' + (division.partes.length > 1 ? ' en ' + division.partes.length + ' tramos' : '')
    + (fallidos.length ? '; OCR incompleto en págs. ' + fallidos.join(', ') + ' — texto incompleto' : '');
  const unido = textos.join('\n');
  if (!unido.trim() && fallidos.length) {
    throw new Error('El OCR no devolvió texto en ningún tramo (págs. ' + fallidos.join(', ') + ').');
  }
  return unido;
}

/**
 * OCR de un tramo. Si falla o devuelve vacío, lo divide en mitades (hasta
 * tramos de OCR_MIN_PAGINAS) y reintenta; los tramos que siguen sin texto se
 * registran en "fallidos" para que el estado del documento lo informe.
 */
async function ocrConReintento_(blob, nombre, desde, hasta, fallidos) {
  let error = null;
  try {
    const t = ocrBlob_(blob, nombre);
    if (t && t.trim()) return t;
  } catch (e) {
    error = e;
  }
  const paginas = hasta - desde + 1;
  if (paginas > CONFIG.OCR_MIN_PAGINAS) {
    try {
      const mitad = Math.ceil(paginas / 2);
      const sub = await dividirPdfEnTramos_(blob, mitad);
      if (sub.partes.length > 1) {
        const a = await ocrConReintento_(sub.partes[0], nombre + ' a', desde, desde + mitad - 1, fallidos);
        const b = await ocrConReintento_(sub.partes[1], nombre + ' b', desde + mitad, hasta, fallidos);
        return [a, b].filter(Boolean).join('\n');
      }
    } catch (e) {
      console.warn('No se pudo subdividir ' + nombre + ': ' + e);
    }
  }
  console.warn('Tramo sin texto ' + nombre + ' (págs. ' + desde + '-' + hasta + '): ' + (error ? error.message || error : 'vacío'));
  fallidos.push(desde + '–' + hasta);
  return '';
}

/**
 * Lista en el registro los documentos que no participan en la búsqueda
 * (sin texto, error u omitidos) con su estado y número de páginas.
 * Para volver a procesarlos, ejecutar después reintentarErrores().
 */
async function diagnosticarDocumentosSinTexto() {
  const sh = getSpreadsheet_().getSheetByName(CONFIG.SHEET_DOCUMENTS);
  if (!sh || sh.getLastRow() < 2) return [];
  const filas = sh.getRange(2, 1, sh.getLastRow() - 1, 7).getValues();
  const salida = [];
  for (let i = 0; i < filas.length; i++) {
    const estado = String(filas[i][6] || '');
    if (estadoDisponible_(estado) && !/texto incompleto/i.test(estado)) continue;
    let paginas = '';
    try {
      if (String(filas[i][2]).toLowerCase().indexOf('pdf') !== -1) {
        paginas = await contarPaginasPdf_(DriveApp.getFileById(String(filas[i][0])).getBlob());
      }
    } catch (e) {
      paginas = 'no se pudo leer: ' + e.message;
    }
    salida.push({ documento: filas[i][1], estado: estado, paginas: paginas, url: filas[i][3] });
  }
  console.log(JSON.stringify(salida, null, 2));
  return salida;
}

/** Agrega la columna "Verificación" a la hoja Documentos si falta. */
function prepararColumnaVerificacion() {
  getOrCreateSheet_(getSpreadsheet_(), CONFIG.SHEET_DOCUMENTS, HEADERS_DOCUMENTS);
  return 'Columna H "Verificación" lista. Escribe "Verificado" (y opcionalmente fecha y nota) en las fuentes cotejadas.';
}

/**
 * Vuelve a indexar solo los PDF de más de 80 páginas (los que quedaron
 * truncados). Ejecutar una vez desde el editor.
 */
async function reindexarPdfsGrandes() {
  const ss = getSpreadsheet_();
  const docSheet = getOrCreateSheet_(ss, CONFIG.SHEET_DOCUMENTS, HEADERS_DOCUMENTS);
  const artSheet = getOrCreateSheet_(ss, CONFIG.SHEET_ARTICLES, HEADERS_ARTICLES);
  if (docSheet.getLastRow() < 2) return await procesarIndexacion_();
  const docs = docSheet.getRange(2, 1, docSheet.getLastRow() - 1, 8).getValues();
  const rehacer = new Set();
  for (let i = 0; i < docs.length; i++) {
    const id = String(docs[i][0] || '');
    const mime = String(docs[i][2] || '').toLowerCase();
    if (!id || mime.indexOf('pdf') === -1) continue;
    try {
      const n = await contarPaginasPdf_(DriveApp.getFileById(id).getBlob());
      if (n > CONFIG.OCR_MAX_PAGINAS) rehacer.add(id);
    } catch (e) {
      console.warn('No se pudo contar páginas de ' + docs[i][1] + ': ' + e);
    }
  }
  if (!rehacer.size) return { ok: true, message: 'No hay PDF de más de ' + CONFIG.OCR_MAX_PAGINAS + ' páginas.' };
  replaceSheetBody_(docSheet, docs.filter(function(r) { return !rehacer.has(String(r[0])); }), 8);
  if (artSheet.getLastRow() >= 2) {
    const arts = artSheet.getRange(2, 1, artSheet.getLastRow() - 1, 8).getValues()
      .filter(function(r) { return !rehacer.has(String(r[0])); });
    replaceSheetBody_(artSheet, arts, 8);
  }
  console.log('PDF a reindexar: ' + rehacer.size);
  return await procesarIndexacion_();
}


/** Ejecuta la indexación mostrando el resultado o el error en el registro. */
async function indexarConRegistro() {
  try {
    const r = await procesarIndexacion_();
    console.log(JSON.stringify(r));
    return r;
  } catch (e) {
    console.error('Error de indexación: ' + (e && e.stack ? e.stack : e));
    throw e;
  }
}


/**
 * Corrige estados escritos como "Texto extraído (N páginas…); M fragmentos"
 * al formato "Texto extraído; M fragmentos (N páginas…)" que espera el catálogo.
 */
function normalizarEstadosDocumentos() {
  const sh = getSpreadsheet_().getSheetByName(CONFIG.SHEET_DOCUMENTS);
  if (!sh || sh.getLastRow() < 2) return 0;
  const rango = sh.getRange(2, 7, sh.getLastRow() - 1, 1);
  let cambios = 0;
  const valores = rango.getValues().map(function(r) {
    const m = String(r[0] || '').match(/^Texto extraído \(([^)]*)\); (\d+ fragmentos);(.*)$/);
    if (!m) return r;
    cambios++;
    return ['Texto extraído; ' + m[2] + ' (' + m[1] + ');' + m[3]];
  });
  rango.setValues(valores);
  console.log('Estados corregidos: ' + cambios);
  return cambios;
}