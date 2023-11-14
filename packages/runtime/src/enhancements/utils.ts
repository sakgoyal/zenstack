/* eslint-disable @typescript-eslint/no-var-requires */

import { lowerCaseFirst } from 'lower-case-first';
import * as util from 'util';
import type { ModelMeta } from '../cross';

/**
 * Gets id fields for the given model.
 */
export function getIdFields(modelMeta: ModelMeta, model: string, throwIfNotFound = false) {
    let fields = modelMeta.fields[lowerCaseFirst(model)];
    if (!fields) {
        if (throwIfNotFound) {
            throw new Error(`Unable to load fields for ${model}`);
        } else {
            fields = {};
        }
    }
    const result = Object.values(fields).filter((f) => f.isId);
    if (result.length === 0 && throwIfNotFound) {
        throw new Error(`model ${model} does not have an id field`);
    }
    return result;
}

/**
 * Formats an object for pretty printing.
 */
export function formatObject(value: unknown) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return util.formatWithOptions ? util.formatWithOptions({ depth: 20 }, value) : (value as any).toString();
}

let _PrismaClientValidationError: new (...args: unknown[]) => Error;
let _PrismaClientKnownRequestError: new (...args: unknown[]) => Error;
let _PrismaClientUnknownRequestError: new (...args: unknown[]) => Error;

/* eslint-disable @typescript-eslint/no-explicit-any */
export function loadPrismaModule(prisma: any) {
    const path = require('path');
    // https://github.com/prisma/prisma/discussions/17832
    if (prisma._engineConfig?.datamodelPath) {
        // try engine path first
        const loadPath = path.dirname(prisma._engineConfig.datamodelPath);
        try {
            const _prisma = require(loadPath).Prisma;
            if (typeof _prisma !== 'undefined') {
                return _prisma;
            }
        } catch {
            // noop
        }
    }

    try {
        // Prisma v4
        return require('@prisma/client/runtime');
    } catch {
        try {
            // Prisma v5
            return require('@prisma/client');
        } catch (err) {
            if (process.env.ZENSTACK_TEST === '1') {
                // running in test, try cwd
                try {
                    return require(path.join(process.cwd(), 'node_modules/@prisma/client/runtime'));
                } catch {
                    return require(path.join(process.cwd(), 'node_modules/@prisma/client'));
                }
            } else {
                throw err;
            }
        }
    }
}

export function prismaClientValidationError(prismaModule: any, message: string) {
    if (!_PrismaClientValidationError) {
        // const _prisma = prismaModule ?? loadPrismaModule(prisma);
        _PrismaClientValidationError = prismaModule.PrismaClientValidationError;
    }
    throw new _PrismaClientValidationError(message, { clientVersion: prismaModule._clientVersion });
}

export function prismaClientKnownRequestError(prismaModule: any, ...args: unknown[]) {
    if (!_PrismaClientKnownRequestError) {
        // const _prisma = loadPrismaModule(prisma);
        _PrismaClientKnownRequestError = prismaModule.PrismaClientKnownRequestError;
    }
    return new _PrismaClientKnownRequestError(...args);
}

export function prismaClientUnknownRequestError(prismaModule: any, ...args: unknown[]) {
    if (!_PrismaClientUnknownRequestError) {
        // const _prisma = loadPrismaModule(prisma);
        _PrismaClientUnknownRequestError = prismaModule.PrismaClientUnknownRequestError;
    }
    throw new _PrismaClientUnknownRequestError(...args);
}
