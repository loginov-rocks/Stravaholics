import { Request, Response } from 'express';

import { WebAuthenticatedRequest } from '../middlewares/WebAuthMiddleware';
import { OAuthService } from '../services/OAuthService';
import { generateCodeChallenge } from '../utils/generate';

interface Options {
  apiBaseUrl: string;
  mcpBaseUrl: string;
  oauthService: OAuthService;
}

// TODO: Draft.
export class OAuthController {
  private readonly apiBaseUrl: string;
  private readonly mcpBaseUrl: string;
  private readonly oauthService: OAuthService;

  private registerRoute: string | null = null;
  private authorizeRoute: string | null = null;
  private callbackRoute: string | null = null;
  private tokenRoute: string | null = null;

  constructor({ apiBaseUrl, mcpBaseUrl, oauthService }: Options) {
    this.apiBaseUrl = apiBaseUrl;
    this.mcpBaseUrl = mcpBaseUrl;
    this.oauthService = oauthService;

    this.getProtectedResource = this.getProtectedResource.bind(this);
    this.getServerMetadata = this.getServerMetadata.bind(this);
    this.postOAuthRegister = this.postOAuthRegister.bind(this);
    this.getOAuthAuthorize = this.getOAuthAuthorize.bind(this);
    this.getOAuthCallback = this.getOAuthCallback.bind(this);
    this.postOAuthToken = this.postOAuthToken.bind(this);
  }

  public getProtectedResource(req: Request, res: Response): void {
    res.send({
      resource: this.mcpBaseUrl,
      authorization_servers: [
        this.apiBaseUrl,
      ],
    });
  }

  public getServerMetadata(req: Request, res: Response): void {
    if (!this.authorizeRoute || !this.registerRoute || !this.tokenRoute) {
      res.status(500).send({ message: 'Internal Server Error' });
      return;
    }

    res.send({
      issuer: this.apiBaseUrl,
      authorization_endpoint: `${this.apiBaseUrl}${this.authorizeRoute}`,
      token_endpoint: `${this.apiBaseUrl}${this.tokenRoute}`,
      registration_endpoint: `${this.apiBaseUrl}${this.registerRoute}`,
      grant_types_supported: [
        'authorization_code',
        'client_credentials',
      ],
      code_challenge_methods_supported: [
        'S256',
      ],
    });
  }

  public async postOAuthRegister(req: Request, res: Response): Promise<void> {
    console.log('postOAuthRegister', req.body);

    const { client_name, grant_types, response_types, token_endpoint_auth_method, scope, redirect_uris } = req.body;

    // TODO: Improve validation.
    if (typeof client_name !== 'string' || !Array.isArray(grant_types) || !Array.isArray(response_types)
      || token_endpoint_auth_method !== 'client_secret_post' || typeof scope !== 'string'
      || !Array.isArray(redirect_uris)) {
      res.status(400).send({ message: 'Bad Request' });
      return;
    }

    let client;
    try {
      client = await this.oauthService.createClient({
        name: client_name,
        redirectUris: redirect_uris,
        scope,
      });
    } catch (error) {
      console.error(error);

      res.status(500).send({ message: 'Internal Server Error' });
      return;
    }

    res.status(201).send({
      client_id: client.id,
      client_name: client.name,
      grant_types,
      response_types,
      token_endpoint_auth_method,
      scope: client.scope,
      redirect_uris: client.redirectUris,
    });
  }

  public async getOAuthAuthorize(req: WebAuthenticatedRequest, res: Response): Promise<void> {
    console.log('getOAuthAuthorize', req.query);

    if (!this.callbackRoute) {
      res.status(500).send({ message: 'Internal Server Error' });
      return;
    }

    const { client_id, code_challenge, code_challenge_method, redirect_uri, response_type, scope, state } = req.query;

    // TODO: Improve validation.
    if (typeof client_id !== 'string' || typeof code_challenge !== 'string' || code_challenge_method !== 'S256'
      || typeof redirect_uri !== 'string' || response_type !== 'code' || typeof scope !== 'string'
      || typeof state !== 'string') {
      res.status(400).send({ message: 'Bad Request' });
      return;
    }

    let client;
    try {
      client = await this.oauthService.getClient(client_id);
    } catch (error) {
      console.error(error);

      res.status(500).send({ message: 'Internal Server Error' });
      return;
    }

    if (!client || !client.redirectUris.includes(redirect_uri) || scope !== client.scope) {
      res.status(400).send({ message: 'Bad Request' });
      return;
    }

    // User is already authorized.
    if (req.userId) {
      let storedCode;
      try {
        storedCode = await this.oauthService.createCode({
          userId: req.userId,
          clientId: client.id,
          codeChallenge: code_challenge,
          redirectUri: redirect_uri,
          scope: scope,
        });
      } catch (error) {
        console.error(error);

        res.status(500).send({ message: 'Internal Server Error' });
        return;
      }

      const url = new URL(redirect_uri);
      url.searchParams.set('code', storedCode.id);
      url.searchParams.set('state', state);
      res.redirect(url.toString());
      return;
    }

    let storedState;
    try {
      storedState = await this.oauthService.createState({
        clientId: client.id,
        codeChallenge: code_challenge,
        redirectUri: redirect_uri,
        scope,
        state,
      });
    } catch (error) {
      console.error(error);

      res.status(500).send({ message: 'Internal Server Error' });
      return;
    }

    const redirectUri = `${this.apiBaseUrl}${this.callbackRoute}`;
    const url = this.oauthService.buildStravaAuthorizeUrl(redirectUri, storedState.id);

    res.redirect(url);
  }

  public async getOAuthCallback(req: Request, res: Response): Promise<void> {
    console.log('getOAuthCallback', req.query);

    const { code, scope, state } = req.query;

    if (typeof code !== 'string' || typeof state !== 'string' || (scope && typeof scope !== 'string')) {
      res.status(400).send({ message: 'Bad Request' });
      return;
    }

    let storedState;
    try {
      storedState = await this.oauthService.getState(state);
    } catch (error) {
      console.error(error);

      res.status(500).send({ message: 'Internal Server Error' });
      return;
    }

    if (!storedState) {
      res.status(400).send({ message: 'Bad Request' });
      return;
    }

    let userId;
    try {
      userId = await this.oauthService.authorizeStravaUser(code, scope, state);
    } catch {
      res.status(401).send({ message: 'Unauthorized' });
      return;
    }

    let storedCode;
    try {
      storedCode = await this.oauthService.createCode({
        userId,
        clientId: storedState.clientId,
        codeChallenge: storedState.codeChallenge,
        redirectUri: storedState.redirectUri,
        scope: storedState.scope,
      });
    } catch (error) {
      console.error(error);

      res.status(500).send({ message: 'Internal Server Error' });
      return;
    }

    const url = new URL(storedState.redirectUri);
    url.searchParams.set('code', storedCode.id);
    url.searchParams.set('state', storedState.state);

    // Delete the stored state at the very last step for better fault tolerance.
    try {
      await this.oauthService.deleteState(storedState.id);
    } catch (error) {
      console.error(error);

      res.status(500).send({ message: 'Internal Server Error' });
      return;
    }

    res.redirect(url.toString());
  }

  public async postOAuthToken(req: Request, res: Response): Promise<void> {
    console.log('postOAuthToken', req.body);

    const { grant_type, code, client_id, code_verifier, redirect_uri, refresh_token } = req.body;

    if (!['authorization_code', 'refresh_token'].includes(grant_type)
      || (grant_type === 'authorization_code' && (typeof code !== 'string' || typeof code_verifier !== 'string'
        || typeof redirect_uri !== 'string'))
      || (grant_type === 'refresh_token' && typeof refresh_token !== 'string')
      || typeof client_id !== 'string') {
      res.status(400).send({ message: 'Bad Request' });
      return;
    }

    let client;
    try {
      client = await this.oauthService.getClient(client_id);
    } catch (error) {
      console.error(error);

      res.status(500).send({ message: 'Internal Server Error' });
      return;
    }

    if (!client) {
      res.status(400).send({ message: 'Bad Request' });
      return;
    }

    let tokens, scope;

    if (grant_type === 'authorization_code') {
      let storedCode;
      try {
        storedCode = await this.oauthService.getCode(code);
      } catch (error) {
        console.error(error);

        res.status(500).send({ message: 'Internal Server Error' });
        return;
      }

      if (!storedCode || client_id !== storedCode.clientId || redirect_uri !== storedCode.redirectUri
        || generateCodeChallenge(code_verifier) !== storedCode.codeChallenge) {
        res.status(400).send({ message: 'Bad Request' });
        return;
      }

      tokens = this.oauthService.createTokens(storedCode.userId, client_id, storedCode.scope);
      scope = storedCode.scope;

      // Delete the stored code at the very last step for better fault tolerance.
      try {
        await this.oauthService.deleteCode(storedCode.id);
      } catch (error) {
        console.error(error);

        res.status(500).send({ message: 'Internal Server Error' });
        return;
      }
    } else if (grant_type === 'refresh_token') {
      let payload;
      try {
        payload = this.oauthService.verifyRefreshToken(refresh_token);
      } catch {
        res.status(401).send({ message: 'Unauthorized' });
        return;
      }

      if (client_id !== payload.clientId || !payload.scope) {
        res.status(400).send({ message: 'Bad Request' });
        return;
      }

      tokens = this.oauthService.createTokens(payload.userId, client_id, payload.scope);
      scope = payload.scope;
    }

    if (!tokens) {
      res.status(500).send({ message: 'Internal Server Error' });
      return;
    }

    res.send({
      access_token: tokens.accessToken,
      token_type: 'Bearer',
      expires_in: tokens.accessTokenExpiresIn,
      refresh_token: tokens.refreshToken,
      scope,
    });
  }

  public setRegisterRoute(registerRoute: string) {
    this.registerRoute = registerRoute;
  }

  public setAuthorizeRoute(authorizeRoute: string) {
    this.authorizeRoute = authorizeRoute;
  }

  public setCallbackRoute(callbackRoute: string) {
    this.callbackRoute = callbackRoute;
  }

  public setTokenRoute(tokenRoute: string) {
    this.tokenRoute = tokenRoute;
  }
}
