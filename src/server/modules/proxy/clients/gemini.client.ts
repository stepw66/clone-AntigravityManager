import { Injectable, Logger } from '@nestjs/common';
import axios, { AxiosProxyConfig, AxiosRequestConfig, AxiosResponse } from 'axios';
import { isNil } from 'lodash-es';
import { GeminiRequest, GeminiResponse } from '../interfaces/request-interfaces';
import { GeminiInternalRequest } from '../../../../lib/antigravity/types';
import { getServerConfig } from '../../../server-config';

@Injectable()
export class GeminiClient {
  private readonly logger = new Logger(GeminiClient.name);
  private readonly defaultRequestUserAgent = 'antigravity/1.11.9 windows/amd64';
  // Default to v1beta for most features
  private readonly baseUrl = 'https://generativelanguage.googleapis.com/v1beta';
  private readonly defaultInternalBaseUrls = [
    'https://cloudcode-pa.googleapis.com/v1internal',
    'https://daily-cloudcode-pa.googleapis.com/v1internal',
  ];

  async streamGenerate(
    model: string,
    content: GeminiRequest,
    accessToken: string,
    upstreamProxyUrl?: string,
  ): Promise<NodeJS.ReadableStream> {
    const url = `${this.baseUrl}/models/${model}:streamGenerateContent?alt=sse`;
    const axiosProxy = this.resolveAxiosProxy(upstreamProxyUrl);

    try {
      const response = await axios.post(url, content, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        responseType: 'stream',
        timeout: 60000,
        proxy: axiosProxy,
      });
      return response.data;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        this.logger.error(`Gemini stream request failed: ${error.message}`);
        throw new Error(error.response?.data?.error?.message || error.message);
      }
      this.throwAsCleanError(error);
    }
  }

  async generate(
    model: string,
    content: GeminiRequest,
    accessToken: string,
    upstreamProxyUrl?: string,
  ): Promise<GeminiResponse> {
    const url = `${this.baseUrl}/models/${model}:generateContent`;
    const axiosProxy = this.resolveAxiosProxy(upstreamProxyUrl);

    try {
      const response = await axios.post<GeminiResponse>(url, content, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        timeout: 60000, // 60s timeout
        proxy: axiosProxy,
      });
      return response.data;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        this.logger.error(
          `Gemini request failed: ${error.message} - ${this.safeStringify(error.response?.data)}`,
        );
        throw new Error(error.response?.data?.error?.message || error.message);
      }
      this.throwAsCleanError(error);
    }
  }

  // --- Internal Gateway API Support ---

  async streamGenerateInternal(
    body: GeminiInternalRequest,
    accessToken: string,
    upstreamProxyUrl?: string,
    extraHeaders?: Record<string, string>,
  ): Promise<NodeJS.ReadableStream> {
    const response = await this.requestWithEndpointFailover<NodeJS.ReadableStream>(
      ':streamGenerateContent?alt=sse',
      body,
      accessToken,
      upstreamProxyUrl,
      {
        responseType: 'stream',
      },
      'stream-generate',
      extraHeaders,
    );

    return response.data;
  }

  async generateInternal(
    body: GeminiInternalRequest,
    accessToken: string,
    upstreamProxyUrl?: string,
    extraHeaders?: Record<string, string>,
  ): Promise<GeminiResponse> {
    const response = await this.requestWithEndpointFailover<
      GeminiResponse | { response: GeminiResponse }
    >(
      ':generateContent',
      body,
      accessToken,
      upstreamProxyUrl,
      {},
      'generate-content',
      extraHeaders,
    );
    const payload = response.data;
    if (payload && typeof payload === 'object' && 'response' in payload) {
      return payload.response;
    }
    return payload;
  }

  private getInternalBaseUrls(): string[] {
    const fromEnv =
      process.env.PROXY_INTERNAL_BASE_URLS ?? process.env.ANTIGRAVITY_INTERNAL_BASE_URLS;
    const configuredBaseUrls = fromEnv
      ?.split(',')
      .map((item) => item.trim())
      .filter(Boolean);

    if (configuredBaseUrls && configuredBaseUrls.length > 0) {
      return configuredBaseUrls.map((url) => url.replace(/\/+$/, ''));
    }

    return this.defaultInternalBaseUrls.map((url) => url.replace(/\/+$/, ''));
  }

  private getInternalTimeoutMs(): number {
    const config = getServerConfig();
    const timeoutSeconds = config?.request_timeout ?? 60;
    return Math.max(1, timeoutSeconds) * 1000;
  }

  private shouldSwitchEndpointOnError(error: unknown): boolean {
    if (!axios.isAxiosError(error)) {
      return false;
    }

    if (!error.response) {
      return true;
    }

    const status = error.response.status;

    // Permanent auth errors should fail fast for current token.
    if (status === 401 || status === 403) {
      return false;
    }

    return status === 408 || status === 429 || status >= 500;
  }

  private async requestWithEndpointFailover<T>(
    path: string,
    body: GeminiInternalRequest,
    accessToken: string,
    upstreamProxyUrl: string | undefined,
    config: AxiosRequestConfig,
    operation: string,
    extraHeaders?: Record<string, string>,
  ): Promise<AxiosResponse<T>> {
    const baseUrls = this.getInternalBaseUrls();
    const timeout = this.getInternalTimeoutMs();
    const requestUserAgent = process.env.PROXY_REQUEST_USER_AGENT ?? this.defaultRequestUserAgent;
    const axiosProxy = this.resolveAxiosProxy(upstreamProxyUrl);
    let lastError: unknown = null;

    for (let index = 0; index < baseUrls.length; index++) {
      const baseUrl = baseUrls[index];
      const url = `${baseUrl}${path}`;

      try {
        return await axios.post<T>(url, body, {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
            'User-Agent': requestUserAgent,
            ...(extraHeaders ?? {}),
          },
          timeout,
          proxy: axiosProxy,
          ...config,
        });
      } catch (error) {
        lastError = error;
        const hasNextEndpoint = index < baseUrls.length - 1;

        if (!hasNextEndpoint || !this.shouldSwitchEndpointOnError(error)) {
          this.handleAxiosError(error, operation);
        }

        this.logger.warn(
          `[${operation}] request failed at ${baseUrl}; trying next endpoint (${index + 2}/${
            baseUrls.length
          }).`,
        );
      }
    }

    this.handleAxiosError(lastError, operation);
  }

  private handleAxiosError(error: unknown, operation: string): never {
    if (axios.isAxiosError(error)) {
      const responseData = error.response?.data;
      const upstreamMessage = this.extractAxiosErrorMessage(responseData);
      this.logger.error(
        `[${operation}] upstream request error: ${error.message} - ${this.safeStringify(responseData)}`,
      );
      throw new Error(upstreamMessage || error.message);
    }
    this.throwAsCleanError(error);
  }

  private extractAxiosErrorMessage(responseData: unknown): string | null {
    if (!responseData || typeof responseData !== 'object') {
      return null;
    }

    const errorRecord = (responseData as { error?: unknown }).error;
    if (!errorRecord || typeof errorRecord !== 'object') {
      return null;
    }

    const message = (errorRecord as { message?: unknown }).message;
    return typeof message === 'string' && message.trim() !== '' ? message : null;
  }

  private resolveAxiosProxy(upstreamProxyUrl?: string): AxiosProxyConfig | false | undefined {
    const config = getServerConfig();
    const configuredProxyUrl =
      upstreamProxyUrl ||
      (config?.upstream_proxy?.enabled && config.upstream_proxy.url
        ? config.upstream_proxy.url
        : '');

    if (!configuredProxyUrl) {
      return undefined;
    }

    try {
      const parsed = new URL(configuredProxyUrl);
      const port = parsed.port ? Number(parsed.port) : parsed.protocol === 'https:' ? 443 : 80;

      const proxyConfig: AxiosProxyConfig = {
        protocol: parsed.protocol.replace(':', ''),
        host: parsed.hostname,
        port,
      };

      if (parsed.username || parsed.password) {
        proxyConfig.auth = {
          username: decodeURIComponent(parsed.username),
          password: decodeURIComponent(parsed.password),
        };
      }

      return proxyConfig;
    } catch {
      this.logger.warn(`Upstream proxy URL is invalid: ${configuredProxyUrl}`);
      return undefined;
    }
  }

  private throwAsCleanError(error: unknown): never {
    // Re-throw as clean Error to avoid circular reference issues.
    throw error instanceof Error ? new Error(error.message) : new Error(String(error));
  }

  /**
   * Safely stringify an object, handling circular references
   */
  private safeStringify(obj: unknown): string {
    if (isNil(obj)) {
      return String(obj);
    }
    try {
      const seen = new WeakSet();
      return JSON.stringify(obj, (key, value) => {
        if (typeof value === 'object' && value !== null) {
          if (seen.has(value)) return '[Circular]';
          seen.add(value);
        }
        return value;
      });
    } catch {
      return '[Unserializable]';
    }
  }
}
