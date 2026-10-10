export default {
  name: 'test-bridge',
  configured: true,
  async findNodes({ fileKey, query, page, nodeType }) {
    return {
      status: 'ok',
      matches: [
        {
          nodeId: '3:240',
          name: 'PB_KEY:home.hero.title',
          fileKey,
          query,
          ...(page ? { page } : {}),
          ...(nodeType ? { nodeType } : {})
        }
      ]
    };
  },
  async dryRun({ fileKey, mode, operations }) {
    return {
      status: 'ok',
      fileKey,
      mode,
      validOperations: operations.length,
      invalidOperations: 0
    };
  },
  async batchApply({ fileKey, mode, operations }) {
    return {
      status: 'applied',
      fileKey,
      mode,
      appliedOperations: operations.length
    };
  }
};
