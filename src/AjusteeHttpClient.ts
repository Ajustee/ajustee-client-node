import {connect, ClientHttp2Session, ClientHttp2Stream, OutgoingHttpHeaders} from 'http2';

export const enum HttpMethod
{
    PUT = 'PUT',
    POST = 'POST',
    GET = 'GET',
    DELETE = 'DELETE'
}

interface httpResponse
{
    status: number;
    content?: string;
}

export class AjusteeHttpClient
{
    private session?: ClientHttp2Session;
    constructor(
        private readonly authority: string,
        private readonly stagePrefix: string,
    ) {}

    connect () 
    {
        return new Promise<void>((resolve)=>
        {
            this.session = connect(this.authority, () => resolve());
        });
    }

    close ()
    {
        return new Promise<void>((resolve)=>
        {
            this.session!.close(resolve);
            this.session = undefined;
        });
    }

    sendRequest (method: HttpMethod, lambdaPath: string, idToken: string)
    {
        return new Promise<httpResponse> ((resolve)=>
        {
            if (!this.session) throw new Error('Session is not connected.');
            const stream = this.session.request({':method': method, ':path': `/${this.stagePrefix}/${lambdaPath}`, Authorization: idToken});
            AjusteeHttpClient.readResponse(stream, resolve);
        });
    }

    sendRequestNoAuth (lambdaPath: string, headers?: OutgoingHttpHeaders)
    {
        return new Promise<httpResponse> ((resolve)=>
        {
            if (!this.session) throw new Error('Session is not connected.');
            if (headers) 
            {
                headers[':method'] = 'GET';
                headers[':path'] = `/${this.stagePrefix}/${lambdaPath}`;
            }
            else headers = {':method': 'GET', ':path': `/${this.stagePrefix}/${lambdaPath}`};
            const stream = this.session.request(headers);
            AjusteeHttpClient.readResponse(stream, resolve);
        });
    }

    sendPayloadRequest (method: HttpMethod, lambdaPath: string, appId: string, isJson: boolean, data: string) //  was modified
    {
        return new Promise<httpResponse> ((resolve)=>
        {
            if (!this.session) throw new Error('Session is not connected.');
            const stream = this.session.request({':method': method, ':path': `/${this.stagePrefix}/${lambdaPath}`, 'X-API-KEY': appId, 'content-type': isJson ? 'application/json' : 'text/plain'});
            stream.write(data);
            stream.end();
            AjusteeHttpClient.readResponse(stream, resolve);
        });
    }

    private static readResponse (stream: ClientHttp2Stream, resolve: (value: httpResponse) => void)
    {
        stream.on('response', (headers) => 
        {
            const status = headers[":status"]!;
            const response: httpResponse = {status};
            if (status === 204) resolve(response);
            else
            {
                const chunks = [] as string[];
                stream.setEncoding('utf8');
                stream.on("data", (chunk: string) => chunks.push(chunk));
                stream.on("end", () => 
                {
                    response.content = chunks.join('');
                    resolve(response);
                });
            }
        });
    }
}