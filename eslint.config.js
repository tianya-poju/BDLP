import globals from 'globals';
export default [{
 files:['frontend/**/*.js'],ignores:['frontend/vendor/**'],
 languageOptions:{ecmaVersion:2022,sourceType:'module',globals:{...globals.browser,AMap:'readonly',QRCode:'readonly'}},
 rules:{'no-undef':'error','no-unused-vars':['error',{args:'none',caughtErrors:'none',varsIgnorePattern:'^_'}]},
}];
