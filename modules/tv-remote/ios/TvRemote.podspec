Pod::Spec.new do |s|
  s.name           = 'TvRemote'
  s.version        = '1.0.0'
  s.summary        = 'TLS with a client certificate and Bonjour discovery for the Android TV remote protocol'
  s.description    = 'Native side of Teclado TV: client certificate, TLS sockets, finding TVs on the Wi-Fi.'
  s.author         = ''
  s.homepage       = 'https://docs.expo.dev/modules/'
  s.platforms      = { :ios => '16.4' }
  s.source         = { git: '' }
  s.static_framework = true
  s.swift_version  = '5.9'
  s.frameworks     = 'Network', 'Security'

  s.dependency 'ExpoModulesCore'

  # Swift/Objective-C compatibility
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
end
