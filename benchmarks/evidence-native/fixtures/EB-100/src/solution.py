def authorize_capability(grant, request, now):
    return grant["operation"] == request["operation"]
