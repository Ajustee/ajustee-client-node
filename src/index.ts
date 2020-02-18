import { AjusteeHttpClient, HttpMethod } from "./AjusteeHttpClient";
import { OutgoingHttpHeaders } from "http2";

const appIdHeader = 'x-api-key';

const enum DataType
{
	Integer = 'Integer',
	String = 'String',
	Boolean = 'Boolean',
	DateTime = 'DateTime',
	Date = 'Date',
}

export interface ConfigurationKey
{
	path: string;
	dataType: DataType;
	value: string | boolean;
}

export class AjusteeClient
{
    private readonly ajusteeHttpClient: AjusteeHttpClient;

    constructor(authority: string, stagePrefix: string, public appId: string, public defaultParams?: OutgoingHttpHeaders)
    {
        this.ajusteeHttpClient = new AjusteeHttpClient(authority, stagePrefix);
    }

    connect () 
    {
        this.ajusteeHttpClient.connect();
    }

    close ()
    {
        this.ajusteeHttpClient.close();
    }

    async getConfigKeys (path?: string, additionalParams?: OutgoingHttpHeaders)
    {
        if (!this.appId) throw new Error('App id is not defined.');
        const requestHeaders = {[appIdHeader]: this.appId};
        if (this.defaultParams) Object.assign(requestHeaders, this.defaultParams);
        if (additionalParams) Object.assign(requestHeaders, additionalParams);
        const response = await this.ajusteeHttpClient.sendRequestNoAuth (path ? `configurationKeys?path=${path}` : 'configurationKeys', requestHeaders);
        if (response.status !== 200) throw new Error (`Invalid status code: ${response.status}. Content: ${response.content || 'undefined'}`);
        return JSON.parse(response.content!) as ConfigurationKey[];
    }

    private async getConfigKeys2 (path?: string, additionalParams?: OutgoingHttpHeaders )
    {
        if (!this.appId) throw new Error('App id is not defined.');
        const requestHeaders = {[appIdHeader]: this.appId};
        if (this.defaultParams) Object.assign(requestHeaders, this.defaultParams);
        if (additionalParams) Object.assign(requestHeaders, additionalParams);
        const response = await this.ajusteeHttpClient.sendRequestNoAuth (path ? `config/${path}` : 'config', requestHeaders);
        if (response.status !== 200) throw new Error (`Invalid status code: ${response.status}. Content: ${response.content || 'undefined'}`);
        return JSON.parse(response.content!) as ConfigurationKey[];
	}
	
	async updateConfigKey (path: string, value: string|boolean|number)
	{
		if (!this.appId) throw new Error('App id is not defined.');
		const response = await this.ajusteeHttpClient.sendPayloadRequest(HttpMethod.PUT, `configurationKeys/${path}`,  this.appId, true, JSON.stringify({value: value.toString()}));
		const statusCode = response.status;
		if(statusCode !== 204) throw new Error(`Invalid response code: ${statusCode}`);
	}

}

