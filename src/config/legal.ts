/**
 * Versão vigente dos documentos legais aceitos no cadastro (Termos de Uso +
 * Política de Privacidade). Carimbada no servidor no aceite do usuário — o
 * cliente NUNCA envia a versão. Ao publicar novos termos que exijam re-aceite,
 * bumpar esta constante (formato de data ISO) e adicionar o fluxo de re-aceite.
 */
export const CURRENT_TERMS_VERSION = '2026-07-09';

/**
 * Versão vigente da Política de IA (`s2core.com.br/politica-ia`) que o titular aceita ao
 * autorizar o tratamento por IA de terceiros (Spec 039). Carimbada no servidor: o cliente
 * NUNCA envia a versão. Ao mudar finalidade, provedor ou dados enviados, bumpar esta
 * constante — o consentimento anterior deixa de valer e a IA volta a pedir autorização.
 */
export const CURRENT_AI_POLICY_VERSION = '2026-10-18';
