declare module "express" {
  export interface Request<
    Params = Record<string, string>,
    ResBody = unknown,
    ReqBody = Record<string, unknown> | undefined,
    ReqQuery = Record<string, unknown>,
  > {
    params: Params;
    body: ReqBody;
    query: ReqQuery;
  }

  export interface Response<ResBody = unknown> {
    status(code: number): Response<ResBody>;
    json(body: ResBody): Response<ResBody>;
    send(body?: ResBody): Response<ResBody>;
    sendStatus(code: number): Response<ResBody>;
  }

  export type NextFunction = (error?: unknown) => void;

  export type RequestHandler<
    Params = Record<string, string>,
    ResBody = unknown,
    ReqBody = Record<string, unknown> | undefined,
    ReqQuery = Record<string, unknown>,
  > = (
    req: Request<Params, ResBody, ReqBody, ReqQuery>,
    res: Response<ResBody>,
    next: NextFunction,
  ) => unknown;

  export type ErrorRequestHandler<
    Params = Record<string, string>,
    ResBody = unknown,
    ReqBody = Record<string, unknown> | undefined,
    ReqQuery = Record<string, unknown>,
  > = (
    error: unknown,
    req: Request<Params, ResBody, ReqBody, ReqQuery>,
    res: Response<ResBody>,
    next: NextFunction,
  ) => unknown;

  export interface Application {
    use(
      ...handlers: Array<
        | RequestHandler
        | ErrorRequestHandler
        | Array<RequestHandler | ErrorRequestHandler>
      >
    ): this;
    get<
      Params = Record<string, string>,
      ResBody = unknown,
      ReqBody = Record<string, unknown> | undefined,
      ReqQuery = Record<string, unknown>,
    >(
      path: string,
      ...handlers: RequestHandler<Params, ResBody, ReqBody, ReqQuery>[]
    ): this;
    post<
      Params = Record<string, string>,
      ResBody = unknown,
      ReqBody = Record<string, unknown> | undefined,
      ReqQuery = Record<string, unknown>,
    >(
      path: string,
      ...handlers: RequestHandler<Params, ResBody, ReqBody, ReqQuery>[]
    ): this;
    put<
      Params = Record<string, string>,
      ResBody = unknown,
      ReqBody = Record<string, unknown> | undefined,
      ReqQuery = Record<string, unknown>,
    >(
      path: string,
      ...handlers: RequestHandler<Params, ResBody, ReqBody, ReqQuery>[]
    ): this;
    listen(port: number, callback?: () => void): unknown;
  }

  export interface ExpressStatic {
    json(options?: { limit?: string | number }): RequestHandler;
    urlencoded(options?: { extended?: boolean }): RequestHandler;
  }

  export interface Express extends ExpressStatic {
    (): Application;
  }

  const express: Express;

  export default express;
}
