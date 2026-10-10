const DEFAULT_SETTINGS = {
  bridgeUrl: 'http://127.0.0.1:3847',
  bridgeToken: '',
  fileKeyOverride: ''
};

let pagesLoadedPromise = null;

async function loadSettings() {
  const stored = (await figma.clientStorage.getAsync('pb-figma-write-bridge-settings')) || {};
  return {
    ...DEFAULT_SETTINGS,
    ...stored
  };
}

async function saveSettings(settings) {
  const nextSettings = {
    bridgeUrl: typeof settings.bridgeUrl === 'string' ? settings.bridgeUrl.trim() : DEFAULT_SETTINGS.bridgeUrl,
    bridgeToken: typeof settings.bridgeToken === 'string' ? settings.bridgeToken.trim() : '',
    fileKeyOverride:
      typeof settings.fileKeyOverride === 'string' ? settings.fileKeyOverride.trim() : ''
  };

  await figma.clientStorage.setAsync('pb-figma-write-bridge-settings', nextSettings);
  return nextSettings;
}

async function collectContext(settings) {
  return {
    pluginId: figma.pluginId || '',
    fileKey: figma.fileKey || settings.fileKeyOverride || '',
    documentName: figma.root.name,
    currentPageId: figma.currentPage.id,
    currentPageName: figma.currentPage.name,
    selectionCount: figma.currentPage.selection.length
  };
}

async function ensurePagesLoaded() {
  if (!pagesLoadedPromise) {
    pagesLoadedPromise =
      typeof figma.loadAllPagesAsync === 'function' ? figma.loadAllPagesAsync() : Promise.resolve();
  }
  await pagesLoadedPromise;
}

function getPageForNode(node) {
  let current = node;
  while (current && current.type !== 'PAGE') {
    current = current.parent;
  }
  return current && current.type === 'PAGE' ? current : null;
}

function previewText(text) {
  return text.length > 120 ? `${text.slice(0, 117)}...` : text;
}

async function loadTextNodeFonts(node) {
  if (node.fontName !== figma.mixed) {
    await figma.loadFontAsync(node.fontName);
    return;
  }

  if (typeof node.getRangeAllFontNames !== 'function') {
    throw new Error(`Text node ${node.id} uses mixed fonts and this plugin cannot inspect them.`);
  }

  const fonts = node.getRangeAllFontNames(0, node.characters.length);
  const uniqueFonts = [];
  const seen = new Set();
  for (const font of fonts) {
    const key = `${font.family}::${font.style}`;
    if (seen.has(key)) continue;
    seen.add(key);
    uniqueFonts.push(font);
  }

  for (const font of uniqueFonts) {
    await figma.loadFontAsync(font);
  }
}

async function findNodes(payload) {
  await ensurePagesLoaded();

  const query = (payload.query || '').trim().toLowerCase();
  const pageFilter = (payload.page || '').trim().toLowerCase();
  const nodeTypeFilter = (payload.nodeType || '').trim().toUpperCase();
  const allNodes = figma.root.findAll((node) => {
    if (!node.name) return false;
    if (query && !node.name.toLowerCase().includes(query)) return false;
    if (nodeTypeFilter && node.type !== nodeTypeFilter) return false;

    const page = getPageForNode(node);
    if (!pageFilter) return true;
    return page?.name.toLowerCase().includes(pageFilter) || page?.id === payload.page;
  });

  return {
    status: 'ok',
    matches: allNodes.slice(0, 200).map((node) => {
      const page = getPageForNode(node);
      return {
        nodeId: node.id,
        name: node.name,
        nodeType: node.type,
        pageId: page?.id || '',
        pageName: page?.name || ''
      };
    })
  };
}

async function dryRun(payload) {
  await ensurePagesLoaded();

  const operations = Array.isArray(payload.operations) ? payload.operations : [];
  const existingNames = new Map();
  const allNamedNodes = figma.root.findAll((node) => Boolean(node.name));

  for (const node of allNamedNodes) {
    const normalized = node.name.trim().toLowerCase();
    if (!normalized) continue;
    const bucket = existingNames.get(normalized) || [];
    bucket.push(node.id);
    existingNames.set(normalized, bucket);
  }

  const errors = [];
  const warnings = [];
  const operationResults = [];

  for (let index = 0; index < operations.length; index += 1) {
    const operation = operations[index];
    const node = figma.getNodeById(operation.nodeId);

    if (!node) {
      errors.push({
        index,
        code: 'missing_node',
        message: `Node ${operation.nodeId} was not found in the current file.`
      });
      operationResults.push({
        index,
        nodeId: operation.nodeId,
        type: operation.type,
        status: 'invalid'
      });
      continue;
    }

    if (operation.type === 'rename_node') {
      const nextName = (operation.newName || '').trim();
      if (!nextName) {
        errors.push({
          index,
          code: 'invalid_new_name',
          message: `Operation ${index} is missing a valid newName.`
        });
        operationResults.push({
          index,
          nodeId: operation.nodeId,
          type: operation.type,
          status: 'invalid'
        });
        continue;
      }

      const duplicateIds = (existingNames.get(nextName.toLowerCase()) || []).filter((id) => id !== node.id);
      if (duplicateIds.length > 0) {
        errors.push({
          index,
          code: 'duplicate_target_name',
          message: `Target name "${nextName}" already exists on another node.`,
          duplicateNodeIds: duplicateIds
        });
      }

      operationResults.push({
        index,
        nodeId: node.id,
        type: operation.type,
        status: duplicateIds.length > 0 ? 'invalid' : 'validated',
        currentName: node.name,
        newName: nextName
      });
      continue;
    }

    if (operation.type === 'set_text') {
      if (node.type !== 'TEXT') {
        errors.push({
          index,
          code: 'not_text_node',
          message: `Node ${node.id} is ${node.type}, not TEXT.`
        });
        operationResults.push({
          index,
          nodeId: node.id,
          type: operation.type,
          status: 'invalid'
        });
        continue;
      }

      const nextText = typeof operation.text === 'string' ? operation.text : '';
      if (!nextText.trim()) {
        errors.push({
          index,
          code: 'invalid_text',
          message: `Operation ${index} is missing a valid text payload.`
        });
      }

      operationResults.push({
        index,
        nodeId: node.id,
        type: operation.type,
        status: nextText.trim() ? 'validated' : 'invalid',
        currentTextPreview: previewText(node.characters),
        nextTextPreview: previewText(nextText)
      });
      continue;
    }

    warnings.push({
      index,
      code: 'unsupported_operation',
      message: `Unsupported operation type "${operation.type}".`
    });
    operationResults.push({
      index,
      nodeId: operation.nodeId,
      type: operation.type,
      status: 'invalid'
    });
  }

  return {
    status: errors.length > 0 ? 'invalid' : 'ok',
    validOperations: operationResults.filter((item) => item.status === 'validated').length,
    invalidOperations: operationResults.filter((item) => item.status === 'invalid').length,
    errors,
    warnings,
    operations: operationResults
  };
}

async function batchApply(payload) {
  const validation = await dryRun(payload);
  if (validation.status !== 'ok') {
    return {
      status: 'invalid',
      ...validation
    };
  }

  const operations = Array.isArray(payload.operations) ? payload.operations : [];
  const applied = [];

  for (const operation of operations) {
    const node = figma.getNodeById(operation.nodeId);
    if (!node) {
      throw new Error(`Node ${operation.nodeId} disappeared before apply.`);
    }

    if (operation.type === 'rename_node') {
      node.name = operation.newName;
      applied.push({
        nodeId: node.id,
        type: operation.type,
        status: 'applied',
        newName: operation.newName
      });
      continue;
    }

    if (operation.type === 'set_text') {
      await loadTextNodeFonts(node);
      node.characters = operation.text;
      applied.push({
        nodeId: node.id,
        type: operation.type,
        status: 'applied',
        textPreview: previewText(operation.text)
      });
    }
  }

  return {
    status: 'applied',
    appliedOperations: applied.length,
    operations: applied
  };
}

async function executeCommand(command) {
  if (!command || !command.type) {
    return {
      status: 'error',
      error: 'Command payload is missing a type.'
    };
  }

  try {
    if (command.type === 'find_nodes') {
      return await findNodes(command.payload || {});
    }

    if (command.type === 'dry_run') {
      return await dryRun(command.payload || {});
    }

    if (command.type === 'batch_apply') {
      return await batchApply(command.payload || {});
    }

    return {
      status: 'error',
      error: `Unsupported command type: ${command.type}`
    };
  } catch (error) {
    return {
      status: 'error',
      error: error.message || 'Figma command failed.'
    };
  }
}

async function bootstrap() {
  const settings = await loadSettings();
  const mode = figma.command === 'configure-bridge' ? 'configure' : 'agent';
  const visible = mode === 'configure';

  figma.showUI(__html__, {
    visible,
    width: visible ? 420 : 320,
    height: visible ? 420 : 0,
    title: 'PB Figma Write Bridge'
  });

  const context = await collectContext(settings);

  figma.ui.postMessage({
    type: 'init',
    mode,
    settings,
    context
  });

  figma.ui.onmessage = async (message) => {
    if (message.type === 'save-settings') {
      const savedSettings = await saveSettings(message.settings || {});
      figma.ui.postMessage({
        type: 'settings-saved',
        settings: savedSettings
      });
      figma.closePlugin('Bridge settings saved.');
      return;
    }

    if (message.type === 'request-context') {
      const latestSettings = await loadSettings();
      figma.ui.postMessage({
        type: 'context',
        context: await collectContext(latestSettings)
      });
      return;
    }

    if (message.type === 'execute-command') {
      const response = await executeCommand(message.command);
      figma.ui.postMessage({
        type: 'command-result',
        commandId: message.command?.id || '',
        response
      });
    }
  };
}

bootstrap();

