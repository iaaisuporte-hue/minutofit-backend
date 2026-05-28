// Registra todas as modalidades na inicialização do módulo
import './sports/jiuJitsu';

export { getSportConfig, getRegisteredSports, isValidSportKey, registerSport } from './registry';
export { computeSportReadiness } from './readiness';
