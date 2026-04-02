function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function stringify(value: unknown): string {
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
		return String(value);
	}
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

function formatCause(cause: unknown): string | undefined {
	if (cause instanceof Error) {
		const parts = [cause.name, cause.message].filter(Boolean);
		const typedCause = cause as Error & {
			code?: unknown;
			errno?: unknown;
			syscall?: unknown;
			address?: unknown;
			port?: unknown;
		};
		if (typedCause.code !== undefined) parts.push(`code=${String(typedCause.code)}`);
		if (typedCause.errno !== undefined) parts.push(`errno=${String(typedCause.errno)}`);
		if (typedCause.syscall !== undefined) parts.push(`syscall=${String(typedCause.syscall)}`);
		if (typedCause.address !== undefined) parts.push(`address=${String(typedCause.address)}`);
		if (typedCause.port !== undefined) parts.push(`port=${String(typedCause.port)}`);
		return parts.join(" | ");
	}

	if (isRecord(cause)) {
		const parts: string[] = [];
		for (const key of ["name", "message", "code", "errno", "syscall", "address", "port"]) {
			const value = cause[key];
			if (value !== undefined) {
				parts.push(`${key}=${stringify(value)}`);
			}
		}
		if (parts.length > 0) {
			return parts.join(" | ");
		}
	}

	if (cause === undefined) return undefined;
	return stringify(cause);
}

export function formatProviderError(error: unknown): string {
	if (!(error instanceof Error)) {
		return stringify(error);
	}

	const typedError = error as Error & {
		status?: unknown;
		requestID?: unknown;
		code?: unknown;
		type?: unknown;
		param?: unknown;
		error?: unknown;
		cause?: unknown;
	};

	const lines = [error.message];
	const fields: string[] = [];
	if (typedError.status !== undefined) fields.push(`status=${String(typedError.status)}`);
	if (typedError.requestID !== undefined) fields.push(`request_id=${String(typedError.requestID)}`);
	if (typedError.code !== undefined) fields.push(`code=${String(typedError.code)}`);
	if (typedError.type !== undefined) fields.push(`type=${String(typedError.type)}`);
	if (typedError.param !== undefined) fields.push(`param=${String(typedError.param)}`);
	if (fields.length > 0) {
		lines.push(fields.join(" "));
	}

	if (isRecord(typedError.error)) {
		const apiFields: string[] = [];
		for (const key of ["message", "code", "type", "param"]) {
			const value = typedError.error[key];
			if (value !== undefined) {
				apiFields.push(`${key}=${stringify(value)}`);
			}
		}
		if (apiFields.length > 0) {
			lines.push(`error: ${apiFields.join(" ")}`);
		}
	}

	const cause = formatCause(typedError.cause);
	if (cause) {
		lines.push(`cause: ${cause}`);
	}

	return lines.join("\n");
}
