# Consultor Normativo Ecuador — sincronización con Apps Script

Este repositorio está preparado para sincronizar los archivos del proyecto con Google Apps Script mediante GitHub Actions y `clasp`.

## Archivos
- `Codigo.gs`: backend del Consultor Normativo.
- `Index.html`: interfaz web.
- `Clasificador.gs`: clasificador independiente de documentos; permanece en modo de prueba (`MODO_PRUEBA: true`).
- `appsscript.json`: manifiesto con runtime V8 y servicio avanzado Drive API v3.
- `.github/workflows/sync-apps-script.yml`: sincroniza al hacer push a `main` o al ejecutar manualmente el workflow.

## Antes de activar la sincronización
1. Crea un repositorio GitHub nuevo llamado `consultor-normativo-ecuador-appscript` bajo la cuenta `saritama26-coder`.
2. Sube el contenido de este paquete a la raíz del repositorio, incluida la carpeta `.github/workflows/`.
3. En el editor del proyecto de Apps Script vinculado a la URL web app proporcionada, copia el **ID del script** desde la URL del editor (`https://script.google.com/home/projects/ID_DEL_SCRIPT/edit`). No uses el ID de despliegue que aparece en la URL `/exec`.
4. En el repositorio, abre **Settings → Secrets and variables → Actions → New repository secret** y crea:
   - `CLASP_JSON`: contenido JSON con el campo `scriptId` y el ID del script correcto, por ejemplo `{"scriptId":"PEGAR_ID_REAL_DEL_SCRIPT","rootDir":"."}`.
   - `CLASPRC_JSON`: contenido completo del archivo `.clasprc.json` generado por `clasp login` en una sesión autorizada.
5. Ejecuta **Actions → Sincronizar Google Apps Script → Run workflow**. Revisa que termine en verde.
6. Para futuras modificaciones, edita los archivos del repositorio y haz `commit`/`push` a `main`. El workflow subirá los archivos al proyecto de Apps Script.

## Importante: el despliegue web no se actualiza automáticamente
`clasp push` sincroniza los archivos del editor, pero no publica una nueva versión de la implementación `/exec`. Después de sincronizar cambios, entra a Apps Script → **Implementar → Gestionar implementaciones → Editar** (icono de lápiz) → **Versión nueva** → **Implementar**. La URL puede mantenerse igual si editas la implementación existente.

## Seguridad y preservación de datos
- No publiques `.clasp.json`, `.clasprc.json`, tokens ni credenciales en el repositorio. El archivo `.clasp.json` se crea dentro de GitHub Actions desde el secreto `CLASP_JSON`.
- No ejecutes `configurarSistema()` ni `reindexarTodo()` durante la sincronización: el propio backend advierte que limpian las hojas del índice.
- No ejecutes el clasificador en modo real sin revisar el registro de prueba y confirmar las carpetas destino. Se mantiene `MODO_PRUEBA: true`.
- El workflow sincroniza el código; no copia ni migra las hojas de cálculo, los documentos de Drive ni los datos existentes.
- El manifiesto declara Drive API v3. Comprueba en Apps Script que el servicio avanzado Drive API esté habilitado y que el manifiesto coincida con el proyecto de destino.

## Límite de esta entrega
El paquete prepara los archivos y el flujo de sincronización. No crea el repositorio en GitHub ni puede vincularse al proyecto real hasta que se configuren el ID real del script y los secretos. La URL `/exec` por sí sola no revela de forma suficiente el ID editable que `clasp` necesita.

## Cambios del 15-10-2026 (búsqueda y citas)

- Modos de coincidencia: todas las palabras (predeterminado), frase exacta y cualquier palabra. Las palabras se comparan completas (con singular/plural) y el texto entre comillas se busca como frase.
- Orden por relevancia (cobertura, frase completa, cercanía entre términos, frecuencia) con porcentaje relativo en cada resultado.
- Paginación con «Cargar más resultados» y resumen de coincidencias agrupadas por documento (clic para filtrar por ese documento).
- Búsqueda directa de artículo con norma: `art. 365 RGLOSNCP`, `art 298 coip`.
- Página de la coincidencia y rango de páginas del extracto, según el folio impreso en el documento. Se asume que el folio («Página N de M») está al pie de cada página.
- Limpieza de encabezados y pies editoriales al mostrar el texto (título de la norma + «Página N», «LEXIS FINDER»). El índice no se modifica.
- Fecha del nombre del archivo y «Última modificación» declarada en el texto, cuando existen.
- Documentos sin texto: se listan en la interfaz y en cada búsqueda. Para revisarlos: ejecutar `diagnosticarDocumentosSinTexto()` y luego `reintentarErrores()`; el OCR ahora reintenta por tramos más pequeños (mínimo `OCR_MIN_PAGINAS`).
- Verificación de fuentes: columna H «Verificación» de la hoja Documentos (ejecutar `prepararColumnaVerificacion()` una vez). Escribir «Verificado» (más fecha o nota) en las fuentes cotejadas con la publicación oficial. Filtro «Solo fuentes verificadas» en la interfaz.
- Corregido: el botón «Copiar texto» no tenía acción y «Exportar resultados a PDF» ocultaba todas las tarjetas al imprimir.

## Cambios del 19-11-2026 (sincronización)

- Hasta esta fecha, `clasp push` terminaba en verde pero no subía nada ("Skipping push.") porque el manifiesto del repositorio no coincidía con el de Apps Script.
- `appsscript.json` ahora incluye la configuración `webapp` vigente en Apps Script (ejecutar como el usuario que implementa; acceso: cualquier persona).
- El workflow fija `@google/clasp@3.4.1`, descarga y valida el proyecto antes de subir (se detiene si hay archivos desconocidos o si el manifiesto difiere), guarda un respaldo de 90 días como artefacto, sube con `--force` y comprueba al final que Apps Script quedó igual al repositorio.
- `.claspignore` limita la subida a `Codigo.gs`, `Clasificador.gs`, `Index.html` y `appsscript.json`. El `index.html` en minúsculas (portada con iframe) y los íconos no se suben a Apps Script.
- En Apps Script, el archivo `Código` pasa a llamarse `Codigo` (mismo contenido).

## Cambios del 19-11-2026 (seguridad, actualización de leyes, cita y remisiones)

- **Seguridad:** la aplicación web es pública y se ejecuta con la cuenta del propietario; cualquier función sin "_" al final podía llamarse desde el navegador. Las funciones de administración (`configurarSistema`, `indexarDocumentosDrive`, `reindexarTodo`, `reintentarErrores`, `actualizarIndice`, `clasificarLeyesVigentes`, diagnósticos, etc.) ahora solo funcionan si las ejecuta el propietario desde el editor. `continuarIndexacion` solo actúa si hay una continuación pendiente. La búsqueda no cambia.
- **`actualizarIndice()`** (ejecutar desde el editor): quita del índice las leyes retiradas de las carpetas o enviadas a la papelera, reindexa las que se modificaron en Drive después de su indexación y agrega las nuevas. Flujo para una ley reformada: reemplazar el archivo en Drive (Administrar versiones, o subir el nuevo y retirar el anterior) y ejecutar `actualizarIndice()`. La columna H «Verificación» de una ley reindexada queda vacía: la nueva versión debe cotejarse otra vez.
- Los archivos en la papelera ya no se indexan.
- **Copiar cita:** botón en cada resultado con el formato «Documento, Art. N, pág. N.» y, si existe, «Publicación: …». Para agregar la publicación: ejecutar `prepararHojaRegistroOficial()` una vez y completar la columna C de la hoja «Registro Oficial».
- **Remisiones:** las menciones «artículo N» / «art. N» dentro del texto son enlaces. Si el texto indica otra norma («del Código…», «de la Ley…») se busca ese artículo en esa norma; si no, en el mismo documento.
