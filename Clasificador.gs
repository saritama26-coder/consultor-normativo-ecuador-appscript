/**
 * Clasificador de documentos legales y técnicos.
 * Ejecutar primero en modo de prueba.
 */
const CONFIG_CLASIFICADOR = {
  CARPETA_PRINCIPAL_ID: "1tChmi3ToWPgpr4uf0nxCMmSYxeqr5EKR",
  MODO_PRUEBA: true
};

const REGLAS_CLASIFICACION = [
  {
    carpeta: "01_Marco_Constitucional_y_General",
    palabras: [
      "constitucion", "codigo civil", "coip",
      "codigo organico administrativo", "coa", "cogep", "cootad"
    ]
  },
  {
    carpeta: "02_Contratacion_y_Control_Publico",
    palabras: [
      "losncp", "contratacion publica", "compras publicas",
      "contraloria", "control interno", "sercop"
    ]
  },
  {
    carpeta: "03_Administracion_y_Servicio_Publico",
    palabras: [
      "losep", "servicio publico",
      "ley organica de las personas con discapacidad",
      "discapacidad", "acuerdo ministerial", "decreto ejecutivo"
    ]
  },
  {
    carpeta: "04_Normativa_Tecnica_y_Construccion",
    palabras: [
      "norma ecuatoriana de la construccion", "normas tecnicas nec",
      "nec", "miduvi", "arquitectura", "construccion",
      "norma tecnica", "normas tecnicas", "ordenanza",
      "accesibilidad universal", "sismorresistente",
      "especificaciones tecnicas"
    ]
  }
];

function normalizarTextoClasificador_(texto) {
  return String(texto || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\\u0300-\\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\\s+/g, " ");
}

function clasificarLeyesVigentes() {
  const carpetaPrincipal = DriveApp.getFolderById(
    CONFIG_CLASIFICADOR.CARPETA_PRINCIPAL_ID
  );

  // Localizar carpetas existentes.
  const carpetasDestino = {};
  const carpetasExistentes = carpetaPrincipal.getFolders();
  while (carpetasExistentes.hasNext()) {
    const carpeta = carpetasExistentes.next();
    carpetasDestino[carpeta.getName()] = carpeta;
  }

  // Crear destinos solo al ejecutar realmente, no en modo de prueba.
  REGLAS_CLASIFICACION.forEach(function(regla) {
    if (!carpetasDestino[regla.carpeta] && !CONFIG_CLASIFICADOR.MODO_PRUEBA) {
      carpetasDestino[regla.carpeta] =
        carpetaPrincipal.createFolder(regla.carpeta);
      Logger.log("[CREADA] " + regla.carpeta);
    }
  });

  const archivos = carpetaPrincipal.getFiles();
  let revisados = 0;
  let movidos = 0;
  let sinCoincidencia = 0;
  let ambiguos = 0;

  while (archivos.hasNext()) {
    const archivo = archivos.next();
    const nombreOriginal = archivo.getName();
    const nombreNormalizado = normalizarTextoClasificador_(nombreOriginal);
    const coincidencias = [];

    REGLAS_CLASIFICACION.forEach(function(regla) {
      const coincide = regla.palabras.some(function(palabra) {
        const p = normalizarTextoClasificador_(palabra);
        return (" " + nombreNormalizado + " ").includes(" " + p + " ");
      });
      if (coincide) coincidencias.push(regla.carpeta);
    });

    revisados++;

    if (coincidencias.length === 0) {
      sinCoincidencia++;
      Logger.log("[SIN CLASIFICAR] " + nombreOriginal);
      continue;
    }

    if (coincidencias.length > 1) {
      ambiguos++;
      Logger.log("[AMBIGUO - NO MOVIDO] " + nombreOriginal +
        " | Posibles carpetas: " + coincidencias.join(", "));
      continue;
    }

    const destinoNombre = coincidencias[0];
    const destino = carpetasDestino[destinoNombre];

    if (CONFIG_CLASIFICADOR.MODO_PRUEBA) {
      Logger.log("[PRUEBA - MOVERÍA] " + nombreOriginal +
        " -> " + destinoNombre);
      continue;
    }

    if (!destino) {
      Logger.log("[ERROR - NO MOVIDO] Falta carpeta destino " +
        destinoNombre + " para " + nombreOriginal);
      continue;
    }

    archivo.moveTo(destino);
    movidos++;
    Logger.log("[MOVIDO] " + nombreOriginal + " -> " + destinoNombre);
  }

  Logger.log("========== RESUMEN ==========");
  Logger.log("Modo de prueba: " + CONFIG_CLASIFICADOR.MODO_PRUEBA);
  Logger.log("Archivos revisados: " + revisados);
  Logger.log("Archivos movidos: " + movidos);
  Logger.log("Sin coincidencia: " + sinCoincidencia);
  Logger.log("Ambiguos (no movidos): " + ambiguos);
  Logger.log("Proceso terminado.");
}