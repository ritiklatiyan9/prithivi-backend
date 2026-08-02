declare module "fastify" {
  interface FastifyRequest {
    rawBody?: Buffer;
  }
}

export {};
