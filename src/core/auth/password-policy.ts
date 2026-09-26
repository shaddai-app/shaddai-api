import { ZxcvbnFactory } from '@zxcvbn-ts/core';
import * as common from '@zxcvbn-ts/language-common';
import * as en from '@zxcvbn-ts/language-en';
import * as esEs from '@zxcvbn-ts/language-es-es';
import * as ptBr from '@zxcvbn-ts/language-pt-br';
import { AppError } from '../http/errors.js';

export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 128; // acota el costo de argon2 ante entradas enormes
const MIN_SCORE = 3;

const zxcvbn = new ZxcvbnFactory({
  graphs: common.adjacencyGraphs,
  dictionary: { ...common.dictionary, ...en.dictionary, ...esEs.dictionary, ...ptBr.dictionary },
});

/**
 * Política NIST: largo mínimo + chequeo contra contraseñas comunes/adivinables, sin reglas de composición.
 * `userInputs` penaliza usar el propio nombre o email.
 */
export function assertStrongPassword(password: string, userInputs: string[] = []): void {
  if (password.length < PASSWORD_MIN_LENGTH || password.length > PASSWORD_MAX_LENGTH) {
    throw AppError.badRequest('PASSWORD_LENGTH', { min: PASSWORD_MIN_LENGTH, max: PASSWORD_MAX_LENGTH });
  }
  const result = zxcvbn.check(password, userInputs);
  if (result.score < MIN_SCORE) {
    throw AppError.badRequest('PASSWORD_TOO_WEAK', {
      score: result.score,
      minScore: MIN_SCORE,
      warning: result.feedback.warning, // clave; el front la traduce
      suggestions: result.feedback.suggestions,
    });
  }
}
