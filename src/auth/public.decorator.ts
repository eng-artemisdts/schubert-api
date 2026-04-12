import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';

/** Marca rotas acessíveis sem Bearer (ex.: health). */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
