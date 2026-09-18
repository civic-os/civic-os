<#import "template.ftl" as layout>
<#import "field.ftl" as field>
<#import "buttons.ftl" as buttons>
<#import "social-providers.ftl" as identityProviders>
<#import "passkeys.ftl" as passkeys>
<#--
  Civic OS Custom Login Theme — Social-First Layout
  Social login buttons render FIRST (inside the "form" section), with the
  email/password form below a divider. The "socialProviders" section is left
  empty so template.ftl doesn't render them a second time.

  SPDX-License-Identifier: AGPL-3.0-or-later
  Copyright (C) 2023-2026 Civic OS, L3C
-->
<@layout.registrationLayout displayMessage=!messagesPerField.existsError('username','password') displayInfo=realm.password && realm.registrationAllowed && !registrationDisabled??; section>

    <#if section = "header">
        ${msg("loginAccountTitle")}

    <#elseif section = "form">
        <div id="kc-form">

          <#-- ── Social login buttons (rendered first for prominence) ── -->
          <#if realm.password && social.providers?? && social.providers?has_content>
              <@identityProviders.show social=social/>

              <#-- Divider: only shown when both social AND email login are active -->
              <#if realm.loginWithEmailAllowed>
                  <div class="civic-os-divider" role="separator">
                      ${msg("civic-os-email-login-divider")}
                  </div>
              </#if>
          </#if>

          <#-- ── Email/password form (hidden when loginWithEmailAllowed is off) ── -->
          <#if realm.loginWithEmailAllowed>
            <div id="kc-form-wrapper" class="<#if realm.password && social.providers?? && social.providers?has_content>civic-os-password-section</#if>">
              <#if realm.password>
                  <form id="kc-form-login" class="${properties.kcFormClass!}" onsubmit="login.disabled = true; return true;" action="${url.loginAction}" method="post" novalidate="novalidate">
                      <#if !usernameHidden??>
                          <#assign label>
                              <#if !realm.loginWithEmailAllowed>${msg("username")}<#elseif !realm.registrationEmailAsUsername>${msg("usernameOrEmail")}<#else>${msg("email")}</#if>
                          </#assign>
                          <@field.input name="username" label=label error=messagesPerField.getFirstError('username','password')
                              autofocus=(!social.providers?? || !social.providers?has_content) autocomplete="${(enableWebAuthnConditionalUI?has_content)?then('username webauthn', 'username')}" value=login.username!'' />
                          <@field.password name="password" label=msg("password") error="" forgotPassword=realm.resetPasswordAllowed autofocus=usernameHidden?? autocomplete="current-password">
                              <#if realm.rememberMe && !usernameHidden??>
                                  <@field.checkbox name="rememberMe" label=msg("rememberMe") value=login.rememberMe?? />
                              </#if>
                          </@field.password>
                      <#else>
                          <@field.password name="password" label=msg("password") forgotPassword=realm.resetPasswordAllowed autofocus=usernameHidden?? autocomplete="current-password">
                              <#if realm.rememberMe && !usernameHidden??>
                                  <@field.checkbox name="rememberMe" label=msg("rememberMe") value=login.rememberMe?? />
                              </#if>
                          </@field.password>
                      </#if>

                      <input type="hidden" id="id-hidden-input" name="credentialId" <#if auth.selectedCredential?has_content>value="${auth.selectedCredential}"</#if>/>
                      <@buttons.loginButton />
                  </form>
              </#if>
            </div>
          </#if>

        </div>
        <@passkeys.conditionalUIData />

    <#elseif section = "socialProviders">
        <#-- Empty: social providers are rendered inside the "form" section above -->

    <#elseif section = "info">
        <#if realm.password && realm.registrationAllowed && !registrationDisabled??>
            <div id="kc-registration-container">
                <div id="kc-registration">
                    <span>${msg("noAccount")} <a href="${url.registrationUrl}">${msg("doRegister")}</a></span>
                </div>
            </div>
        </#if>
    </#if>

</@layout.registrationLayout>
