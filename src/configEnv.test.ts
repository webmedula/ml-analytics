import { describe, expect, it } from 'vitest';
import { envDeUmDestes, normalizarUrlBase } from './config';
import { motivoSemConfiguracao } from './core/diagnosticoCustos';

describe('configuração do backup (v56)', () => {
  it('limpa espaços e aspas e aceita nomes alternativos', () => {
    expect(envDeUmDestes(['BACKUP_API_KEY', 'PANEL_API_KEY'], { BACKUP_API_KEY: '  "abc"  ' })).toEqual({ valor: 'abc', nome: 'BACKUP_API_KEY' });
    expect(envDeUmDestes(['BACKUP_API_KEY', 'PANEL_API_KEY'], { BACKUP_API_KEY: ' ', PANEL_API_KEY: 'x' })).toEqual({ valor: 'x', nome: 'PANEL_API_KEY' });
    expect(envDeUmDestes(['A'], {})).toEqual({ valor: '', nome: null });
  });
  it('URL sem https e com barra no fim', () => {
    expect(normalizarUrlBase('backup.mcs.ind.br/')).toBe('https://backup.mcs.ind.br');
    expect(normalizarUrlBase('http://x:3000//')).toBe('http://x:3000');
    expect(normalizarUrlBase('')).toBe('');
  });
  it('o aviso diz qual variável falta e lembra do deploy', () => {
    expect(motivoSemConfiguracao('https://b', '')).toMatch(/não enxerga BACKUP_API_KEY\./);
    expect(motivoSemConfiguracao('', '')).toMatch(/BACKUP_BASE_URL e BACKUP_API_KEY/);
    expect(motivoSemConfiguracao('', '')).toMatch(/deploy/);
  });
});
