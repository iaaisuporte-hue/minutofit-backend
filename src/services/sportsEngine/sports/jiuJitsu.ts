import type { SportConfig } from '../../../types/sport';
import { registerSport } from '../registry';

const jiuJitsuConfig: SportConfig = {
  key: 'jiu_jitsu',
  labelPt: 'Jiu-Jitsu',
  graduationOptions: ['branca', 'cinza', 'amarela', 'laranja', 'verde', 'azul', 'roxa', 'marrom', 'preta'],
  categoryOptions: [
    '-56kg', '-62kg', '-69kg', '-76kg', '-85kg', '-94kg', '-100kg', '+100kg',
    '-49kg', '-55kg', '-62kg', '-70kg', '+70kg', // feminino
    'absoluto',
  ],
  factorWeights: {
    joint_soreness: 25,
    muscle_soreness: 15,
    stress_level: 10,
    motivation: 10,
    camp_proximity: 10,
    weekly_load_threshold: 5,
    weekly_load_penalty: 8,
  },
  microcopy: {
    readinessHigh: 'Condição ideal para treino técnico ou sparring moderado.',
    readinessModerate: 'Prefira técnica e rolagem leve. Monitore sinais de fadiga.',
    readinessLow: 'Priorize recuperação — evite sparrings intensos hoje.',
  },
};

registerSport(jiuJitsuConfig);

export default jiuJitsuConfig;
